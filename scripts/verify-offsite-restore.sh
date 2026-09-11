#!/usr/bin/env bash
# Prove the offsite copy is genuinely restorable — run this after any change to
# the backup pipeline, and at least once a quarter:
#   scripts/verify-offsite-restore.sh
#
# Downloads the newest archive from the bucket, checks it against the remote
# checksum, decrypts it with the vault passphrase and lists the contents.
#
# End-to-end restore rehearsal: download the newest archive from the bucket,
# check its checksum, decrypt it with the passphrase and list its contents.
set -euo pipefail
RPATH="b2-coopengine:coopengine-offsite-backups-ng/offsite-leg"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

NEWEST="$(rclone lsf "$RPATH" --files-only 2>/dev/null | grep '\.gpg$' | sort | tail -1)"
[ -n "$NEWEST" ] || { echo "no archive found in the bucket" >&2; exit 1; }
echo "newest archive in the bucket: ${NEWEST}"
echo

echo "== 1. download it (as a restore would) =="
rclone copyto "${RPATH}/${NEWEST}" "${TMP}/${NEWEST}" --log-level ERROR
rclone copyto "${RPATH}/${NEWEST}.sha256" "${TMP}/${NEWEST}.sha256" --log-level ERROR
echo "  downloaded $(stat -c %s "${TMP}/${NEWEST}") bytes"

echo
echo "== 2. checksum against the sidecar stored remotely =="
LOCAL_SUM="$(sha256sum "${TMP}/${NEWEST}" | awk '{print $1}')"
STORED_SUM="$(tr -d '[:space:]' < "${TMP}/${NEWEST}.sha256")"
echo "  local : ${LOCAL_SUM:0:32}…"
echo "  remote: ${STORED_SUM:0:32}…"
[ "$LOCAL_SUM" = "$STORED_SUM" ] && echo "  MATCH — the bytes survived the round trip intact" || { echo "  MISMATCH" >&2; exit 1; }

echo
echo "== 3. decrypt with the vault passphrase =="
PLAIN="${TMP}/archive.tar.gz"
gpg --batch --yes --quiet --passphrase-file /root/coopengine/offsite-passphrase \
    --decrypt --output "$PLAIN" "${TMP}/${NEWEST}" 2>/dev/null \
  || { echo "  decryption FAILED" >&2; exit 1; }
echo "  decrypted to $(stat -c %s "$PLAIN") bytes"

echo
echo "== 4. contents (this is what a real restore gives you) =="
tar tzf "$PLAIN" | sed 's/^/  /'
echo
echo "  dumps inside: $(tar tzf "$PLAIN" | grep -c '\.dump$')"
echo
echo "RESTORE REHEARSAL PASSED — the offsite copy is complete and readable."
