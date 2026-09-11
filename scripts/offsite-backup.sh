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

# Load the operator configuration the systemd unit provides via EnvironmentFile,
# so manual runs behave exactly like the nightly timer.
OFFSITE_ENV_FILE="${OFFSITE_ENV_FILE:-/root/coopengine/offsite.env}"
if [ -f "$OFFSITE_ENV_FILE" ]; then
  # Explicit environment values win over the file (so ad-hoc runs can override).
  declare -A _keep=()
  for _v in OFFSITE_TARGET OFFSITE_DIR OFFSITE_RCLONE KEEP OFFSITE_ENCRYPT DUMP_DIR UPLOADS_DIR ARCHIVE_DIR PASSPHRASE_FILE; do
    [ -n "${!_v:-}" ] && _keep[$_v]="${!_v}"
  done
  set -a
  # shellcheck disable=SC1090
  . "$OFFSITE_ENV_FILE"
  set +a
  for _v in "${!_keep[@]}"; do export "$_v=${_keep[$_v]}"; done
fi

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

# 4. archive (+ encrypt unless the destination is already an encrypted vault)
ARCHIVE="$ARCHIVE_DIR/coopengine-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$STAGE" payload
if [ "${OFFSITE_ENCRYPT:-1}" = "0" ]; then
  UPLOAD_FILE="$ARCHIVE"
  log "encryption: DISABLED (OFFSITE_ENCRYPT=0) — archive is plain; only use this with an rclone crypt remote"
else
  gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
    --passphrase-file "$PASSPHRASE_FILE" \
    --output "${ARCHIVE}.gpg" "$ARCHIVE"
  rm -f "$ARCHIVE"
  UPLOAD_FILE="${ARCHIVE}.gpg"
fi
sha256sum "$UPLOAD_FILE" | awk '{print $1}' > "${UPLOAD_FILE}.sha256"
log "archive: $(basename "$UPLOAD_FILE") ($(du -h "$UPLOAD_FILE" | cut -f1))"

# 5. copy offsite (and verify the copy)
# Target forms:
#   OFFSITE_TARGET="dir:/mnt/backups"                               (mounted path)
#   OFFSITE_TARGET="rclone:b2-remote:backup-bucket/offsite-leg"     (any rclone remote)
#   OFFSITE_TARGET="/mnt/backups"                                   (bare path = dir)
# Legacy variables OFFSITE_DIR / OFFSITE_RCLONE still work.
TARGET_KIND=""
TARGET_PATH=""
if [ -n "${OFFSITE_TARGET:-}" ]; then
  case "$OFFSITE_TARGET" in
    rclone:*) TARGET_KIND=rclone; TARGET_PATH="${OFFSITE_TARGET#rclone:}" ;;
    dir:*)    TARGET_KIND=dir;    TARGET_PATH="${OFFSITE_TARGET#dir:}" ;;
    /*)       TARGET_KIND=dir;    TARGET_PATH="$OFFSITE_TARGET" ;;
    *)        TARGET_KIND=rclone; TARGET_PATH="$OFFSITE_TARGET" ;;
  esac
elif [ -n "${OFFSITE_DIR:-}" ]; then
  TARGET_KIND=dir; TARGET_PATH="$OFFSITE_DIR"
elif [ -n "${OFFSITE_RCLONE:-}" ]; then
  TARGET_KIND=rclone; TARGET_PATH="$OFFSITE_RCLONE"
fi

ARCHIVE_NAME="$(basename "$UPLOAD_FILE")"
LOCAL_SHA="$(cut -d' ' -f1 < "${UPLOAD_FILE}.sha256")"
UPLOADED=0

if [ -z "$TARGET_KIND" ]; then
  log "no offsite target configured — archive staged locally only"
  log "  set OFFSITE_TARGET in /root/coopengine/offsite.env, e.g."
  log "  OFFSITE_TARGET=\"rclone:b2-encrypted-vault:backup-bucket/offsite-leg\""
elif [ "$TARGET_KIND" = "dir" ]; then
  [ -d "$TARGET_PATH" ] || fail "offsite directory does not exist: $TARGET_PATH"
  cp "$UPLOAD_FILE" "${UPLOAD_FILE}.sha256" "$TARGET_PATH/"
  DEST_SUM="$(sha256sum "$TARGET_PATH/$ARCHIVE_NAME" | awk '{print $1}')"
  [ "$LOCAL_SHA" = "$DEST_SUM" ] || fail "checksum mismatch after copying to $TARGET_PATH"
  log "offsite copy verified at $TARGET_PATH (sha256 $DEST_SUM)"
  UPLOADED=1
else
  # ---- rclone target -------------------------------------------------------
  command -v rclone >/dev/null 2>&1 || fail "OFFSITE_TARGET is an rclone remote but rclone is not installed"
  REMOTE_ROOT="${TARGET_PATH%%:*}"                       # remote name
  REMOTE_SUB="${TARGET_PATH#*:}"                         # bucket/prefix (may be empty)
  if ! rclone lsd "${REMOTE_ROOT}:" >/dev/null 2>&1; then
    fail "rclone remote '${REMOTE_ROOT}:' is not reachable — check 'rclone config' and the credentials"
  fi
  log "rclone target: ${REMOTE_ROOT}:${REMOTE_SUB} (remote reachable)"
  # Make sure the destination container exists (no-op when it already does).
  if ! rclone mkdir "${TARGET_PATH}" >/dev/null 2>&1; then
    fail "could not create/prepare the destination ${TARGET_PATH} (bucket missing or key not scoped for it)"
  fi
  rclone copy "$UPLOAD_FILE" "${TARGET_PATH}" --checksum --stats-one-line --log-level ERROR 2>>"$LOG" \
    || fail "rclone copy failed for ${ARCHIVE_NAME}"
  rclone copy "${UPLOAD_FILE}.sha256" "${TARGET_PATH}" --checksum --log-level ERROR 2>>"$LOG" \
    || fail "rclone copy failed for the checksum sidecar"

  # Verify what actually landed: compare a remote hash when the backend reports
  # one (B2 gives sha1/md5), otherwise fall back to a size comparison.
  REMOTE_JSON="$(rclone lsjson --hash "${TARGET_PATH}" --files-only 2>/dev/null || echo '[]')"
  VERIFIED="$(python3 - "$REMOTE_JSON" "$ARCHIVE_NAME" "$UPLOAD_FILE" <<'VERIFY'
import hashlib, json, sys
raw, name, local_path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    entries = json.loads(raw)
except Exception:
    entries = []
entry = next((e for e in entries if e.get('Name') == name), None)
if not entry:
    print('missing')
    raise SystemExit
hashes = {k.lower(): v for k, v in (entry.get('Hashes') or {}).items()}
if hashes:
    for algo in ('sha256', 'sha1', 'md5'):
        if algo in hashes:
            h = hashlib.new(algo)
            with open(local_path, 'rb') as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b''):
                    h.update(chunk)
            print('ok' if h.hexdigest() == hashes[algo] else 'mismatch:' + algo)
            raise SystemExit
print('size:' + ('ok' if int(entry.get('Size') or 0) == __import__('os').path.getsize(local_path) else 'mismatch'))
VERIFY
)"
  case "$VERIFIED" in
    ok) log "offsite upload verified by remote hash (${REMOTE_ROOT}:${REMOTE_SUB}/$ARCHIVE_NAME)" ;;
    size:ok) log "offsite upload verified by size (backend reports no hash; sha256 checked locally)" ;;
    missing) fail "upload verification failed: $ARCHIVE_NAME not found at ${TARGET_PATH}" ;;
    *) fail "upload verification failed: $VERIFIED" ;;
  esac
  UPLOADED=1
fi

if [ -n "${OFFSITE_RCLONE:-}" ] && [ "$TARGET_KIND" != "rclone" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "$UPLOAD_FILE" "$OFFSITE_RCLONE" --checksum --log-level ERROR 2>>"$LOG" \
      || fail "rclone copy to OFFSITE_RCLONE failed"
    log "rclone copy complete: $OFFSITE_RCLONE"
  else
    log "OFFSITE_RCLONE set but rclone is not installed — skipping"
  fi
fi
# 6. prune remote + local archives
# Archives are named coopengine-<UTC stamp>, so a reverse lexical sort is
# newest-first.
if [ "${TARGET_KIND:-}" = "rclone" ] && [ "${OFFSITE_REMOTE_KEEP:-1}" = "1" ]; then
  mapfile -t REMOTE_FILES < <(rclone lsf "$TARGET_PATH" --files-only 2>/dev/null \
    | grep -E '\.(gpg|tar\.gz)$' | sort -r || true)
  if [ "${#REMOTE_FILES[@]}" -gt "$KEEP" ]; then
    PRUNED=0
    for f in "${REMOTE_FILES[@]:$KEEP}"; do
      if rclone deletefile "${TARGET_PATH}/${f}" >/dev/null 2>&1; then
        rclone deletefile "${TARGET_PATH}/${f}.sha256" >/dev/null 2>&1 || true
        PRUNED=$((PRUNED + 1))
      fi
    done
    log "pruned ${PRUNED} remote archive(s), keeping the newest $KEEP at ${TARGET_PATH}"
    log "NOTE: B2 keeps file versions — add a bucket lifecycle rule to expire old versions (docs/deploy.md)"
  fi
fi


mapfile -t OLD < <(ls -1t "$ARCHIVE_DIR"/*.gpg "$ARCHIVE_DIR"/*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) || true)
if [ "${#OLD[@]}" -gt 0 ]; then
  for f in "${OLD[@]}"; do rm -f "$f" "$f.sha256"; done
  log "pruned ${#OLD[@]} archive(s), keeping the newest $KEEP"
fi

if [ "$UPLOADED" -eq 1 ]; then
  log "offsite backup complete (offsite leg: uploaded and verified)"
else
  log "offsite backup complete (offsite leg: staged locally only)"
fi
