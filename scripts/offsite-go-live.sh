#!/usr/bin/env bash
# Co-opEngine offsite go-live — one command, prompt once for the B2 key.
#
#   scripts/offsite-go-live.sh              # set up + lifecycle + supervised first upload
#   scripts/offsite-go-live.sh --dry-run    # show the plan and check prerequisites only
#
# Steps:
#   1. register the rclone remote (hidden prompts for keyID + application key)
#   2. derive the bucket's S3 endpoint from Backblaze and apply the lifecycle rule
#      (reusing the key already in rclone.conf — no second prompt)
#   3. preflight, flip OFFSITE_TARGET, run the supervised first upload, verify the
#      remote hash, list the vault, re-run the watchdog
set -uo pipefail
cd /root/CoopEngine-core

KEY_FILE="${KEY_FILE:-}"
REMOTE="${REMOTE:-b2-coopengine}"
BUCKET="${BUCKET:-coopengine-offsite-backups-ng}"
PREFIX="${PREFIX:-offsite-leg}"
LIFECYCLE_DAYS="${LIFECYCLE_DAYS:-30}"
DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --remote=*) REMOTE="${arg#*=}" ;;
    --bucket=*) BUCKET="${arg#*=}" ;;
    --prefix=*) PREFIX="${arg#*=}" ;;
    --days=*)   LIFECYCLE_DAYS="${arg#*=}" ;;
    --key-file=*) KEY_FILE="${arg#*=}" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

echo "Co-opEngine offsite go-live"
echo "  remote : ${REMOTE}"
echo "  bucket : ${BUCKET}"
echo "  prefix : ${PREFIX}"
echo "  lifecycle: expire noncurrent versions after ${LIFECYCLE_DAYS} days"
echo

if [ "$DRY" = "1" ]; then
  echo "== prerequisites =="
  command -v rclone >/dev/null 2>&1 && echo "  rclone           : $(rclone version | head -1)" || echo "  rclone           : MISSING"
  [ -f scripts/setup-offsite-remote.sh ] && echo "  setup script     : present" || echo "  setup script     : MISSING"
  [ -f scripts/offsite-enable.sh ] && echo "  enable script    : present" || echo "  enable script    : MISSING"
  if rclone listremotes 2>/dev/null | grep -qx "${REMOTE}:"; then
    echo "  remote registered: yes (${REMOTE}:)"
  else
    echo "  remote registered: no — step 1 will ask for the keyID and application key"
  fi
  echo "  secrets on disk  : rclone.conf mode $(stat -c %a /root/.config/rclone/rclone.conf 2>/dev/null || echo '-')"
  echo
  echo "dry run only — nothing was changed."
  exit 0
fi

# ---------------------------------------------------------------- 1. the remote
if rclone listremotes 2>/dev/null | grep -qx "${REMOTE}:"; then
  echo "== 1/3 remote already registered: ${REMOTE}: (skipping key entry) =="
else
  echo "== 1/3 registering the remote (the key is read at hidden prompts) =="
  SETUP_ARGS=(--name="$REMOTE" --bucket="$BUCKET" --prefix="$PREFIX")
  [ -n "$KEY_FILE" ] && SETUP_ARGS+=(--key-file="$KEY_FILE")
  bash scripts/setup-offsite-remote.sh "${SETUP_ARGS[@]}" || {
    echo
    echo "Setup did not complete. Re-run this script when you have the keyID and" >&2
    echo "application key to hand (they are on the Application Keys page in Backblaze)." >&2
    exit 1
  }
fi

# ------------------------------------------------------------- 2. lifecycle rule
echo
echo "== 2/3 lifecycle rule (reuses the key from rclone.conf) =="
CONF="${RCLONE_CONFIG:-$HOME/.config/rclone/rclone.conf}"
KEY_ID="$(awk -v r="[${REMOTE}]" '$0==r{f=1;next} /^\[/{f=0} f&&/^account *=/{sub(/^account *= */,"");print;exit}' "$CONF" 2>/dev/null)"
APP_KEY="$(awk -v r="[${REMOTE}]" '$0==r{f=1;next} /^\[/{f=0} f&&/^key *=/{sub(/^key *= */,"");print;exit}' "$CONF" 2>/dev/null)"

if [ -z "$KEY_ID" ] || [ -z "$APP_KEY" ]; then
  echo "  could not read the key from $CONF — skipping (apply it later with:"
  echo "    B2_KEY_ID=… B2_APP_KEY=… scripts/setup-b2-lifecycle.sh --days ${LIFECYCLE_DAYS})"
else
  # Backblaze tells us the S3 endpoint for this account; guessing the region is
  # the usual reason a lifecycle call fails.
  S3_ENDPOINT="$(curl -sS --max-time 20 -u "${KEY_ID}:${APP_KEY}" \
      https://api.backblazeb2.com/b2api/v3/b2_authorize_account 2>/dev/null \
    | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print((d.get("apiInfo") or {}).get("s3ApiUrl") or (d.get("s3ApiUrl") or ""))
except Exception:
    print("")')"
  apply_lifecycle() { # endpoint (may be empty)
    local endpoint="$1"
    if [ -n "$endpoint" ]; then
      echo "  account S3 endpoint: ${endpoint}"
      B2_KEY_ID="$KEY_ID" B2_APP_KEY="$APP_KEY" B2_BUCKET="$BUCKET" B2_ENDPOINT="$endpoint" \
        bash scripts/setup-b2-lifecycle.sh --days "$LIFECYCLE_DAYS"
    else
      echo "  endpoint unknown (key may lack listBuckets) — trying the default region"
      B2_KEY_ID="$KEY_ID" B2_APP_KEY="$APP_KEY" B2_BUCKET="$BUCKET" \
        bash scripts/setup-b2-lifecycle.sh --days "$LIFECYCLE_DAYS"
    fi
  }

  apply_lifecycle "$S3_ENDPOINT" ||
    echo "  lifecycle rule was not applied — the offsite leg still works; retry this step later"
fi
unset APP_KEY KEY_ID

# ------------------------------------------------- 3. flip + supervised upload
echo
echo "== 3/3 supervised first upload =="
bash scripts/offsite-enable.sh --remote="$REMOTE" --bucket="$BUCKET" --prefix="$PREFIX" || {
  echo
  echo "The offsite leg was NOT enabled. Nothing is broken: the nightly job keeps" >&2
  echo "staging archives locally. Fix the reported problem and re-run this script." >&2
  exit 1
}

echo
echo "Done. From now on the 03:10 timer uploads and the 07:00 watchdog reports."
