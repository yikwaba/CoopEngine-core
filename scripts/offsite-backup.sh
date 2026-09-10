#!/usr/bin/env bash
# Co-opEngine offsite backup: nightly database dumps + KYC uploads, encrypted
# before they leave the box.
#
#   scripts/offsite-backup.sh                # archive + verify + prune locally
#   OFFSITE_DIR=/mnt/backups scripts/offsite-backup.sh
#   OFFSITE_RCLONE=myremote:coopengine scripts/offsite-backup.sh
#
# Configuration (env):
#   OFFSITE_DIR     directory to copy the encrypted archive to (e.g. a mounted
#                   volume, NFS share or USB disk). Unset = staging only.
#   OFFSITE_RCLONE  rclone remote:path (used when the rclone binary exists).
#   KEEP            how many local archives to retain (default 14).
#   PASSPHRASE_FILE default /root/coopengine/offsite-passphrase (auto-generated,
#                   mode 600 — copy it somewhere safe; without it the archives
#                   cannot be restored).
set -euo pipefail

DUMP_DIR="${DUMP_DIR:-/var/lib/postgresql/backups}"
UPLOADS_DIR="${UPLOADS_DIR:-/root/coopengine/uploads}"
ARCHIVE_DIR="${ARCHIVE_DIR:-/root/coopengine/backup-archives}"
PASSPHRASE_FILE="${PASSPHRASE_FILE:-/root/coopengine/offsite-passphrase}"
LOG_DIR="${LOG_DIR:-/root/coopengine/logs}"
KEEP="${KEEP:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$ARCHIVE_DIR" "$LOG_DIR"
LOG="$LOG_DIR/offsite-backup.log"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
fail() { log "ERROR: $*"; exit 1; }

log "=== offsite backup run $STAMP ==="

# 1. passphrase
if [ ! -s "$PASSPHRASE_FILE" ]; then
  umask 077
  openssl rand -base64 48 > "$PASSPHRASE_FILE"
  chmod 600 "$PASSPHRASE_FILE"
  log "generated a new backup passphrase at $PASSPHRASE_FILE"
  log "WARNING: copy this file somewhere safe — archives are useless without it"
fi

# 2. stage the payload
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PAYLOAD="$STAGE/payload"
mkdir -p "$PAYLOAD/database" "$PAYLOAD/uploads"

LATEST_DUMP="$(ls -1t "$DUMP_DIR"/*.dump 2>/dev/null | head -1 || true)"
if [ -z "$LATEST_DUMP" ]; then
  fail "no database dump found in $DUMP_DIR"
fi
cp "$LATEST_DUMP" "$PAYLOAD/database/"
# keep the two most recent dumps together for point-in-time choice
ls -1t "$DUMP_DIR"/*.dump 2>/dev/null | sed -n '2p' | while read -r d; do [ -n "$d" ] && cp "$d" "$PAYLOAD/database/"; done
log "database: $(ls -1 "$PAYLOAD/database" | tr '\n' ' ')"

if [ -d "$UPLOADS_DIR" ]; then
  cp -a "$UPLOADS_DIR/." "$PAYLOAD/uploads/" 2>/dev/null || true
  log "uploads: $(find "$PAYLOAD/uploads" -type f | wc -l) file(s), $(du -sh "$PAYLOAD/uploads" | cut -f1)"
else
  log "uploads: directory absent (nothing uploaded yet)"
fi

# 3. manifest for a human-readable inventory
{
  echo "coopengine backup manifest"
  echo "created: $STAMP"
  echo "host: $(hostname)"
  echo "database dumps:"
  (cd "$PAYLOAD/database" && ls -l | sed 's/^/  /')
  echo "uploads:"
  (cd "$PAYLOAD" && find uploads -type f | sed 's/^/  /')
} > "$PAYLOAD/MANIFEST.txt"

# 4. archive + encrypt
ARCHIVE="$ARCHIVE_DIR/coopengine-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$STAGE" payload
gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
  --passphrase-file "$PASSPHRASE_FILE" \
  --output "${ARCHIVE}.gpg" "$ARCHIVE"
rm -f "$ARCHIVE"
sha256sum "${ARCHIVE}.gpg" | awk '{print $1}' > "${ARCHIVE}.gpg.sha256"
log "archive: $(basename "${ARCHIVE}.gpg") ($(du -h "${ARCHIVE}.gpg" | cut -f1))"

# 5. copy offsite (and verify the copy)
if [ -n "${OFFSITE_DIR:-}" ]; then
  [ -d "$OFFSITE_DIR" ] || fail "OFFSITE_DIR does not exist: $OFFSITE_DIR"
  cp "${ARCHIVE}.gpg" "${ARCHIVE}.gpg.sha256" "$OFFSITE_DIR/"
  LOCAL_SUM="$(cut -d' ' -f1 < "${ARCHIVE}.gpg.sha256")"
  REMOTE_SUM="$(sha256sum "$OFFSITE_DIR/$(basename "${ARCHIVE}.gpg")" | awk '{print $1}')"
  [ "$LOCAL_SUM" = "$REMOTE_SUM" ] || fail "checksum mismatch after copying to $OFFSITE_DIR"
  log "offsite copy verified at $OFFSITE_DIR (sha256 $REMOTE_SUM)"
else
  log "OFFSITE_DIR unset — archive staged locally only (set it to complete the offsite leg)"
fi

if [ -n "${OFFSITE_RCLONE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "${ARCHIVE}.gpg" "$OFFSITE_RCLONE" --quiet
    log "rclone copy complete: $OFFSITE_RCLONE"
  else
    log "OFFSITE_RCLONE set but rclone is not installed — skipping"
  fi
fi

# 6. prune local archives
mapfile -t OLD < <(ls -1t "$ARCHIVE_DIR"/*.gpg 2>/dev/null | tail -n +$((KEEP + 1)) || true)
if [ "${#OLD[@]}" -gt 0 ]; then
  for f in "${OLD[@]}"; do rm -f "$f" "$f.sha256"; done
  log "pruned ${#OLD[@]} archive(s), keeping the newest $KEEP"
fi

log "offsite backup complete"
