#!/usr/bin/env bash
# Flip the offsite backup to a live rclone target and prove it with a supervised
# first upload.
#
#   scripts/offsite-enable.sh                                  # uses the values below
#   scripts/offsite-enable.sh --remote=b2-coopengine --bucket=backup-bucket --prefix=offsite-leg
#
# Refuses to write anything unless the remote is reachable and writable, so a
# typo can never turn the nightly job into a failing loop.
set -euo pipefail
cd /root/CoopEngine-core

REMOTE="${REMOTE:-b2-coopengine}"
BUCKET="${BUCKET:-backup-bucket}"
PREFIX="${PREFIX:-offsite-leg}"
for arg in "$@"; do
  case "$arg" in
    --remote=*) REMOTE="${arg#*=}" ;;
    --bucket=*) BUCKET="${arg#*=}" ;;
    --prefix=*) PREFIX="${arg#*=}" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ENVF=/root/coopengine/offsite.env
TARGET="rclone:${REMOTE}:${BUCKET}/${PREFIX}"

echo "== preflight =="
if ! command -v rclone >/dev/null 2>&1; then
  echo "rclone is not installed — run: curl https://rclone.org/install.sh | bash" >&2
  exit 1
fi
if ! rclone listremotes 2>/dev/null | grep -qx "${REMOTE}:"; then
  echo "remote '${REMOTE}:' does not exist yet." >&2
  echo "  create it with:  scripts/setup-offsite-remote.sh --name=${REMOTE} --bucket=${BUCKET} --prefix=${PREFIX}" >&2
  echo "  (it will ask for the Backblaze keyID and application key at hidden prompts)" >&2
  exit 1
fi
echo "  remote exists: ${REMOTE}:"
if ! rclone lsd "${REMOTE}:" >/dev/null 2>&1; then
  echo "remote '${REMOTE}:' is not reachable — check the credentials" >&2
  exit 1
fi
echo "  remote reachable"
if ! rclone mkdir "${TARGET}" 2>/dev/null; then
  echo "cannot prepare ${TARGET} — bucket missing, or the key is not scoped to it" >&2
  exit 1
fi
echo "  destination ready: ${TARGET}"

echo
echo "== writing OFFSITE_TARGET into ${ENVF} =="
cp "$ENVF" "${ENVF}.bak"; chmod 600 "${ENVF}.bak"
python3 - "$ENVF" "$TARGET" <<'PY'
import pathlib, re, sys
envf, target = sys.argv[1], sys.argv[2]
p = pathlib.Path(envf)
lines = p.read_text().splitlines()
out, found = [], False
for line in lines:
    if re.match(r'^\s*#?\s*OFFSITE_TARGET=', line):
        if not found:
            out.append(f'OFFSITE_TARGET="{target}"')
            found = True
        continue
    out.append(line)
if not found:
    out.append(f'OFFSITE_TARGET="{target}"')
p.write_text('\n'.join(out).rstrip('\n') + '\n')
PY
chmod 600 "$ENVF"
grep -n '^OFFSITE_TARGET=' "$ENVF" | sed 's/^/  /'

echo
echo "== supervised first upload =="
bash scripts/offsite-backup.sh | tail -8 | sed 's/^/  /'

echo
echo "== verify the vault contents =="
rclone lsf "$TARGET" 2>/dev/null | tail -5 | sed 's/^/  /'

echo
echo "== watchdog =="
WATCHDOG_VERBOSE=1 bash scripts/backup-watchdog.sh | sed 's/^/  /'

echo
echo "offsite leg is LIVE. Rollback with:"
echo "  cp ${ENVF}.bak ${ENVF}   # or comment the OFFSITE_TARGET line"
