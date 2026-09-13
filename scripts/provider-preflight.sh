#!/usr/bin/env bash
# Co-opEngine provider preflight — validates Termii + Monnify credentials
# WITHOUT ever printing a secret. Exits non-zero when something is wrong.
#
#   scripts/provider-preflight.sh              # validate whatever is configured
#   scripts/provider-preflight.sh --require    # fail if any credential is missing
#   ENV_FILE=/path/providers.env scripts/provider-preflight.sh
#
# Reads from $ENV_FILE (default /root/coopengine/providers.env):
#   TERMII_API_KEY, TERMII_SENDER_ID, TERMII_TEST_PHONE (optional)
#   MONNIFY_API_KEY, MONNIFY_SECRET_KEY, MONNIFY_CONTRACT_CODE,
#   MONNIFY_BASE_URL (default https://api.monnify.com)
#
# Exit codes: 0 ok (skips allowed) · 1 validation failure · 2 missing credentials with --require
set -uo pipefail

ENV_FILE="${ENV_FILE:-/root/coopengine/providers.env}"
REQUIRE=0
[ "${1:-}" = "--require" ] && REQUIRE=1

TERMII_BASE_DEFAULT="https://api.ng.termii.com"
MONNIFY_BASE_DEFAULT="https://api.monnify.com"
FAILED=0
MISSING=0

mask() { # mask a secret, showing only outer characters
  local v="$1"
  local n=${#v}
  if [ "$n" -le 8 ]; then printf '****'; else printf '%s…%s' "${v:0:4}" "${v: -4}"; fi
}

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  echo "env file: $ENV_FILE (root-only)"
else
  echo "env file: $ENV_FILE missing — nothing configured yet"
fi

TERMII_BASE="${TERMII_BASE_URL:-$TERMII_BASE_DEFAULT}"
MONNIFY_BASE="${MONNIFY_BASE_URL:-$MONNIFY_BASE_DEFAULT}"

echo
echo "== Termii (SMS OTP) =="
if [ -z "${TERMII_API_KEY:-}" ] || [ -z "${TERMII_SENDER_ID:-}" ]; then
  echo "  MISSING: TERMII_API_KEY and/or TERMII_SENDER_ID"
  MISSING=1
else
  echo "  api key: $(mask "$TERMII_API_KEY")   sender id: ${TERMII_SENDER_ID}   base: ${TERMII_BASE}"
  BAL="$(curl -sS --max-time 15 "${TERMII_BASE}/api/get-balance?api_key=${TERMII_API_KEY}" 2>/dev/null || true)"
  if printf '%s' "$BAL" | grep -qiE 'balance'; then
    BALANCE="$(printf '%s' "$BAL" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("balance",""))
except Exception:
    print("")' 2>/dev/null || true)"
    echo "  auth: OK   wallet: ${BALANCE:-unknown}"
    # An empty wallet accepts every request and delivers nothing — worth shouting about.
    LOW="$(python3 - "$BALANCE" <<'PY' 2>/dev/null || echo no
import sys
try:
    print("yes" if float(sys.argv[1]) <= 500 else "no")
except Exception:
    print("unknown")
PY
)"
    case "$LOW" in
      yes) echo "  WARNING: wallet balance is very low — top up before members depend on it" ;;
      unknown) echo "  note: could not read the balance as a number" ;;
    esac
  else
    echo "  auth: FAILED (no balance payload returned — check the API key)"
    FAILED=1
  fi
  if [ -n "${TERMII_TEST_PHONE:-}" ]; then
    SEND="$(curl -sS --max-time 20 -X POST "${TERMII_BASE}/api/sms/send" \
      -H 'Content-Type: application/json' \
      --data-binary "$(python3 - "$TERMII_API_KEY" "$TERMII_TEST_PHONE" "$TERMII_SENDER_ID" <<'PY'
import json, sys
print(json.dumps({
    "api_key": sys.argv[1],
    "to": sys.argv[2],
    "from": sys.argv[3],
    "type": "plain",
    "channel": "generic",
    "message": "Co-opEngine connectivity test — please ignore.",
}))
PY
)" 2>/dev/null || true)"
    if printf '%s' "$SEND" | grep -qiE 'message_id|"code":"ok"'; then
      echo "  test SMS: SENT to ${TERMII_TEST_PHONE}"
    else
      echo "  test SMS: FAILED (no message id returned)"
      printf '  termii replied: %s\n' "$(printf '%s' "$SEND" | head -c 300)"
      echo "  likely causes, in order:"
      echo "    1. the sender ID '$TERMII_SENDER_ID' is not approved by the carriers yet"
      echo "       (Termii must approve it; until then messages are rejected or fall back)"
      echo "    2. no credit in the wallet"
      echo "    3. the destination number is not in international format (234…, no leading 0)"
      FAILED=1
    fi
  else
    echo "  test SMS: skipped (set TERMII_TEST_PHONE to send one)"
  fi
fi

echo
echo "== Monnify (virtual accounts) =="
if [ -z "${MONNIFY_API_KEY:-}" ] || [ -z "${MONNIFY_SECRET_KEY:-}" ] || [ -z "${MONNIFY_CONTRACT_CODE:-}" ]; then
  echo "  MISSING: MONNIFY_API_KEY / MONNIFY_SECRET_KEY / MONNIFY_CONTRACT_CODE"
  MISSING=1
else
  echo "  api key: $(mask "$MONNIFY_API_KEY")   contract: $(mask "$MONNIFY_CONTRACT_CODE")   base: ${MONNIFY_BASE}"
  # Basic auth header built in-process; the secret never reaches the shell history.
  AUTH_HEADER="$(python3 - "$MONNIFY_API_KEY" "$MONNIFY_SECRET_KEY" <<'PY'
import base64, sys
print('Basic ' + base64.b64encode(f'{sys.argv[1]}:{sys.argv[2]}'.encode()).decode())
PY
)"
  AUTH="$(curl -sS --max-time 20 -X POST "${MONNIFY_BASE}/api/v1/auth/login" \
    -H "Authorization: ${AUTH_HEADER}" \
    -H 'Content-Type: application/json' 2>/dev/null || true)"
  unset AUTH_HEADER
  if printf '%s' "$AUTH" | grep -q 'accessToken'; then
    echo "  auth: OK (access token received)"
  else
    echo "  auth: FAILED (no access token — check the key/secret pair and base URL)"
    FAILED=1
  fi
fi

echo
if [ "$REQUIRE" -eq 1 ] && [ "$MISSING" -eq 1 ]; then
  echo "preflight: credentials MISSING (--require)"
  exit 2
fi
if [ "$FAILED" -ne 0 ]; then
  echo "preflight: FAILURES present — fix them before switching providers"
  exit 1
fi
echo "preflight: OK (skips are allowed unless --require is used)"
exit 0
