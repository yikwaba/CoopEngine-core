#!/usr/bin/env bash
# Termii go-live in one command.
#
#   scripts/termii-onboard.sh --key-file=/root/termii.key
#   scripts/termii-onboard.sh                      # hidden prompts instead
#
# Key file layout (mode 600, deleted after use):
#   line 1  TERMII_API_KEY
#   line 2  TERMII_SENDER_ID        (e.g. COOPENG)
#   line 3  TERMII_TEST_PHONE       optional, a number you control (e.g. 08031234567)
#
# What it does, in order, stopping safely at the first problem:
#   1. writes the credentials to the root-only providers.env (atomic, backed up, masked output)
#   2. preflight: validates them and sends a REAL test SMS to your number
#   3. switches OTP + notification SMS to Termii
#   4. verifies end to end: a member OTP request must now come back WITHOUT the code
#      (the code goes to the phone instead) and report provider "termii"
#   5. if anything after the switch fails, it rolls back to the dev provider automatically
#
# It never prints a secret. Safe to re-run.
set -uo pipefail

REPO="/root/CoopEngine-core"
ENV_FILE="/root/coopengine/providers.env"
API_BASE="${API_BASE:-http://127.0.0.1:3999/api/v1}"
TEST_SLUG="${TEST_SLUG:-sunrise}"
TEST_MEMBER_EMAIL="${TEST_MEMBER_EMAIL:-member01@sunrise.coop}"
KEY_FILE=""
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --key-file=*) KEY_FILE="${arg#*=}" ;;
    --slug=*) TEST_SLUG="${arg#*=}" ;;
    --member=*) TEST_MEMBER_EMAIL="${arg#*=}" ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf 'cannot continue: %s\n' "$*" >&2; exit 1; }
mask() {
  local v="$1" n=${#1}
  if [ "$n" -le 8 ]; then printf '****'; else printf '%s…%s' "${v:0:4}" "${v: -4}"; fi
}

# ---------------------------------------------------------------- gather values
API_KEY=""; SENDER_ID=""; TEST_PHONE=""
if [ -n "$KEY_FILE" ]; then
  [ -f "$KEY_FILE" ] || die "key file not found: $KEY_FILE"
  API_KEY="$(sed -n '1p' "$KEY_FILE" | tr -d '\r' | xargs)"
  SENDER_ID="$(sed -n '2p' "$KEY_FILE" | tr -d '\r' | xargs)"
  TEST_PHONE="$(sed -n '3p' "$KEY_FILE" | tr -d '\r' | xargs)"
  say "read credentials from $KEY_FILE (file will be shredded)"
else
  say "Enter the values (nothing is echoed or logged):"
  read -r -s -p "  Termii API key: " API_KEY; echo
  read -r -p  "  Sender ID (e.g. COOPENG): " SENDER_ID
  read -r -p  "  Your phone for the test SMS (optional, blank to skip): " TEST_PHONE
fi

[ -n "$API_KEY" ] || die "no API key supplied"
[ -n "$SENDER_ID" ] || die "no sender ID supplied"
case "$SENDER_ID" in
  *[!A-Za-z0-9]*) die "sender ID must be letters/numbers only (Termii rejects spaces and symbols)" ;;
esac
if [ "${#SENDER_ID}" -gt 11 ]; then
  say "note: '$SENDER_ID' is longer than 11 characters — Nigerian carriers usually only accept 11."
fi

# ---------------------------------------------------------------- write the env
step "writing credentials to $ENV_FILE (mode 600, atomic, backed up)"
[ -f "$ENV_FILE" ] || printf 'MEMBER_OTP_PROVIDER=dev\nMONNIFY_PROVIDER=dev\n' > "$ENV_FILE"
BACKUP="${ENV_FILE}.bak.$(date -u +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$BACKUP"
TMP="$(mktemp)"
grep -vE '^(TERMII_API_KEY|TERMII_SENDER_ID|TERMII_TEST_PHONE|TERMII_CHANNEL|TERMII_BASE_URL|TERMII_TIMEOUT_MS)=' "$ENV_FILE" > "$TMP" || true
{
  printf 'TERMII_API_KEY=%s\n' "$API_KEY"
  printf 'TERMII_SENDER_ID=%s\n' "$SENDER_ID"
  [ -n "$TEST_PHONE" ] && printf 'TERMII_TEST_PHONE=%s\n' "$TEST_PHONE"
} >> "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"
[ -n "$KEY_FILE" ] && shred -u "$KEY_FILE" 2>/dev/null || true
say "  api key    $(mask "$API_KEY")"
say "  sender id  $SENDER_ID"
say "  test phone ${TEST_PHONE:-(none - the test SMS will be skipped)}"
say "  backup     $BACKUP"

# ---------------------------------------------------------------- preflight
step "preflight: validating the credentials with Termii"
bash "$REPO/scripts/provider-preflight.sh" --require
PF=$?
if [ "$PF" -ne 0 ]; then
  say ""
  say "Preflight failed, so nothing was switched on — the platform is unchanged (still dev mode)."
  say "Most common causes:"
  say "  * the API key was copied with a stray space or truncated"
  say "  * the sender ID has not been approved by the carriers yet (Termii must approve it)"
  say "  * the wallet has no credit"
  say "Fix it and re-run: scripts/termii-onboard.sh --key-file=<file>"
  exit "$PF"
fi

# ---------------------------------------------------------------- switch
step "switching OTP + notification SMS to Termii"
bash "$REPO/scripts/provider-switch.sh" termii || {
  say "switch failed — rolling back to the dev provider"
  bash "$REPO/scripts/provider-switch.sh" rollback || true
  exit 1
}

# ---------------------------------------------------------------- verify for real
step "verifying end to end (the member code must now go to the phone, not the screen)"
VERIFY_FAILED=0
RESP="$(curl -s --max-time 25 -X POST "$API_BASE/auth/member/request-otp" \
  -H 'content-type: application/json' \
  -d "{\"organizationSlug\":\"$TEST_SLUG\",\"email\":\"$TEST_MEMBER_EMAIL\"}" || true)"
say "  response: $(printf '%s' "$RESP" | head -c 160)"

PROVIDER="$(printf '%s' "$RESP" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("provider",""))
except Exception: print("")' 2>/dev/null)"
HAS_CODE="$(printf '%s' "$RESP" | grep -c 'devCode' || true)"

if [ "$PROVIDER" = "termii" ]; then
  say "  provider reported by the API: termii  ✓"
else
  say "  provider reported by the API: '${PROVIDER:-none}' — expected 'termii'"
  VERIFY_FAILED=1
fi
if [ "$HAS_CODE" = "0" ]; then
  say "  the code is NOT in the API response  ✓ (it went to the member's phone)"
else
  say "  the code is STILL being returned in the response — the switch did not take effect"
  VERIFY_FAILED=1
fi

step "notification channel"
NOTIF="$(curl -s --max-time 20 "$API_BASE/health/providers" || true)"
say "  $(printf '%s' "$NOTIF" | head -c 120)"
say "  (protected endpoint — an empty reply just means no session was supplied here)"

# ---------------------------------------------------------------- outcome
if [ "$VERIFY_FAILED" -eq 0 ]; then
  say ""
  say "TERMII IS LIVE. Members now receive their login codes by SMS, and SMS notifications"
  say "will be delivered by Termii on the nightly 06:30 dispatch."
  say ""
  say "Rollback at any time:  $REPO/scripts/provider-switch.sh rollback"
  exit 0
fi

say ""
say "Verification failed — rolling back to the dev provider so nothing is left half-on."
bash "$REPO/scripts/provider-switch.sh" rollback || true
exit 1
