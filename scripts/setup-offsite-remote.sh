#!/usr/bin/env bash
# Co-opEngine offsite remote setup (rclone).
#
#   scripts/setup-offsite-remote.sh                       # interactive
#   scripts/setup-offsite-remote.sh --type=local --name=test-vault --path=/tmp/x
#
# Creates/refreshes an rclone remote in ~/.config/rclone/rclone.conf (mode 600),
# verifies it can list and write, then (optionally) wraps it in rclone's own
# `crypt` layer and prints the OFFSITE_TARGET line to use.
#
# Credentials are read from hidden prompts (or B2_KEY_ID / B2_APP_KEY when
# piping) and are never echoed, never passed on the command line and never
# written anywhere except the 600-mode config.
set -euo pipefail

TYPE=b2
NAME=b2-encrypted-vault
BUCKET=coopengine-offsite-backups
PREFIX=offsite-leg
CRYPT=ask
PROVIDER=

for arg in "$@"; do
  case "$arg" in
    --type=*)   TYPE="${arg#*=}" ;;
    --name=*)   NAME="${arg#*=}" ;;
    --bucket=*) BUCKET="${arg#*=}" ;;
    --prefix=*) PREFIX="${arg#*=}" ;;
    --path=*)   PROVIDER="${arg#*=}" ;;
    --crypt)    CRYPT=yes ;;
    --no-crypt) CRYPT=no ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

CONF_DIR="${HOME}/.config/rclone"
CONF="${RCLONE_CONFIG:-$CONF_DIR/rclone.conf}"
mkdir -p "$CONF_DIR"; chmod 700 "$CONF_DIR"

prompt_secret() { # prompt_secret "label" VARNAME
  local label="$1" var="$2" val=""
  if [ -n "${!var:-}" ]; then
    eval "$var=\$(printf '%s' \"\${!var}\" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    return
  fi
  printf '%s (hidden): ' "$label" >&2
  IFS= read -rs val
  printf '\n' >&2
  eval "$var=\$(printf '%s' \"\$val\" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
}

if [ -f "$CONF" ]; then
  cp "$CONF" "${CONF}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  chmod 600 "$CONF".bak-* 2>/dev/null || true
  echo "existing rclone config backed up"
fi

if [ "$TYPE" = "b2" ]; then
  prompt_secret "Backblaze B2 keyID (application key, scoped to the bucket)" B2_KEY_ID
  prompt_secret "Backblaze B2 application key" B2_APP_KEY
  [ -n "$B2_KEY_ID" ] || { echo "no keyID provided — aborting" >&2; exit 1; }
  [ -n "$B2_APP_KEY" ] || { echo "no application key provided — aborting" >&2; exit 1; }

  # Rewrite (or append) the remote block without clobbering other remotes.
  python3 - "$CONF" "$NAME" "$B2_KEY_ID" "$B2_APP_KEY" <<'PY'
import pathlib, re, sys
conf, name, key_id, app_key = sys.argv[1:5]
p = pathlib.Path(conf)
text = p.read_text() if p.exists() else ''
block = f"[{name}]\ntype = b2\naccount = {key_id}\nkey = {app_key}\nhard_delete = false\n"
pattern = re.compile(rf'^\[{re.escape(name)}\].*?(?=^\[|\Z)', re.M | re.S)
text = pattern.sub(block, text) if pattern.search(text) else (text.rstrip('\n') + '\n\n' + block if text.strip() else block)
p.write_text(text)
PY
  chmod 600 "$CONF"
else
  # local / other type: handy for rehearsals
  python3 - "$CONF" "$NAME" "$TYPE" "$PROVIDER" <<'PY'
import pathlib, re, sys
conf, name, typ, provider = sys.argv[1:5]
p = pathlib.Path(conf)
text = p.read_text() if p.exists() else ''
block = f"[{name}]\ntype = {typ}\n"
if typ == 'local':
    block += f"nounc = true\n"  # local backend needs no options; path is in the target
elif provider:
    block += f"provider = {provider}\n"
pattern = re.compile(rf'^\[{re.escape(name)}\].*?(?=^\[|\Z)', re.M | re.S)
text = pattern.sub(block, text) if pattern.search(text) else (text.rstrip('\n') + '\n\n' + block if text.strip() else block)
p.write_text(text)
PY
  chmod 600 "$CONF"
fi

echo
echo "--- verifying the remote can list and write ---"
TARGET_BASE="${NAME}:"
if [ "$TYPE" = "b2" ]; then TARGET_BASE="${NAME}:${BUCKET}"; fi
if ! rclone lsd "${NAME}:" >/dev/null 2>&1; then
  echo "FAILED: 'rclone lsd ${NAME}:' did not succeed — check the key and bucket scope" >&2
  exit 1
fi
echo "  listing OK: ${NAME}:"

TESTPATH="${TARGET_BASE}/${PREFIX}"
if ! rclone mkdir "$TESTPATH" 2>/dev/null; then
  echo "FAILED: cannot create/prepare ${TESTPATH} (bucket missing, or the key is not scoped to it)" >&2
  exit 1
fi
echo "  destination ready: ${TESTPATH}"

echo "coopengine offsite round-trip $(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/offsite-rt.txt
if ! rclone copyto /tmp/offsite-rt.txt "${TESTPATH}/round-trip.txt" --log-level ERROR 2>/dev/null; then
  echo "FAILED: test upload did not complete" >&2
  rm -f /tmp/offsite-rt.txt
  exit 1
fi
BACK="$(rclone cat "${TESTPATH}/round-trip.txt" 2>/dev/null || true)"
rm -f /tmp/offsite-rt.txt
if [ -z "$BACK" ]; then
  echo "FAILED: test object could not be read back" >&2
  exit 1
fi
rclone deletefile "${TESTPATH}/round-trip.txt" >/dev/null 2>&1 || true
echo "  round-trip OK (write → read → delete)"

if [ "$CRYPT" = "ask" ] && [ -t 0 ]; then
  printf 'Wrap the remote in rclone crypt (client-side encryption)? [y/N] ' >&2
  read -r ans
  case "$ans" in [yY]*) CRYPT=yes ;; *) CRYPT=no ;; esac
elif [ "$CRYPT" = "ask" ]; then
  CRYPT=no
fi

FINAL_TARGET="${NAME}:${PREFIX}"
if [ "$TYPE" = "b2" ]; then FINAL_TARGET="${NAME}:${BUCKET}/${PREFIX}"; fi

if [ "$CRYPT" = "yes" ]; then
  prompt_secret "crypt passphrase (stored obscured in the 600-mode config)" CRYPT_PASS
  [ -n "$CRYPT_PASS" ] || { echo "no passphrase provided — aborting" >&2; exit 1; }
  OBSCURED="$(rclone obscure "$CRYPT_PASS")"
  SALT="$(rclone obscure "$(openssl rand -base64 24)")"
  python3 - "$CONF" "${NAME}-crypt" "$FINAL_TARGET" "$OBSCURED" "$SALT" <<'PY'
import pathlib, re, sys
conf, name, remote, pw, salt = sys.argv[1:6]
p = pathlib.Path(conf)
text = p.read_text()
block = (f"[{name}]\ntype = crypt\nremote = {remote}\n"
         f"password = {pw}\npassword2 = {salt}\n"
         "filename_encryption = standard\ndirectory_name_encryption = true\n")
pattern = re.compile(rf'^\[{re.escape(name)}\].*?(?=^\[|\Z)', re.M | re.S)
text = pattern.sub(block, text) if pattern.search(text) else (text.rstrip('\n') + '\n\n' + block)
p.write_text(text)
PY
  chmod 600 "$CONF"
  echo
  echo "crypt remote created: ${NAME}-crypt → ${FINAL_TARGET}"
  echo "  (keep the passphrase safe: without it the crypt remote cannot be read)"
  echo
  echo "add this line to /root/coopengine/offsite.env:"
  echo "  OFFSITE_TARGET=\"rclone:${NAME}-crypt:/${PREFIX}\""
  echo
  echo "NOTE: with crypt in place the archives are already encrypted; the gpg layer"
  echo "      then adds a second envelope. Set OFFSITE_ENCRYPT=0 to keep only crypt."
else
  echo
  echo "add this line to /root/coopengine/offsite.env:"
  echo "  OFFSITE_TARGET=\"rclone:${FINAL_TARGET}\""
  echo "  (keep the gpg layer — archives stay portable to any machine with gpg)"
fi
