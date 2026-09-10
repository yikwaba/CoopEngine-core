#!/usr/bin/env bash
# Co-opEngine provider preflight — validates Termii + Monnify credentials
# WITHOUT printing any secret. Safe to run anytime; exits non-zero on failure.
#
# Usage:
#   SUPABASE_UNUSED=1 bash scripts/provider-preflight.sh
#   ENV_FILE=/root/coopengine/providers.env bash scripts/provider-preflight.sh
#
# Reads variables from $ENV_FILE (default /root/coopengine/providers.env):
#   TERMII_API_KEY, TERMII_SENDER_ID, TERMII_TEST_PHONE (optional)
#   MONNIFY_API_KEY, MONNIFY_SECRET_KEY, MONNIFY_CONTRACT_CODE,
#   MONNIFY_BASE_URL (default https://api.monnify.com)
set -uo pipefail
ENV_FILE="${ENV_FILE:-/root/coopengine/providers.env}"
FAILED=0

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  echo "env file loaded: $ENV_FILE"
else
  echo "env file missing: $ENV_FILE (nothing to validate yet)"
fi

mask() { printf '%s' "$1" | sed -E 's/^(....).*(....)$/\1…\2/'; }

# ---------------------------------------------------------------- Termii
echo
echo "== Termii =="
if [ -z "${TERMII_API_KEY:-}" ]; then
  echo "  SKIP: TERMII_API_KEY not set"
else
  echo "  key: $(mask "$TERMII_API_KEY")  sender: ${TERMII_SENDER_ID:-<unset>}"
  BAL=$(curl -sS --max-time 15 "https://api.ng.termii.com/api/get-balance?api_key=${TERMII_API_KEY}" 2>/dev/null || echo '')
  if printf '%s' "$BAL" | grep -qi 'balance'; then
    echo "  auth: OK  ($(printf '%s' "$BAL" | tr -d '\n' | head -c 120))"
  else
    echo "  auth: FAILED (response did not look like a balance payload)"
    FAILED=1
  fi
  if [ -n "${TERMII_TEST_PHONE:-}" ]; then
    SEND=$(curl -sS --max-time 20 -X POST https://api.ng.termii.com/api/sms/send \
      -H 'Content-Type: application/json' \
      -d "{\"api_key\":\"${TERMII_API_KEY}\",\"to\":\"${TERMII_TEST_PHONE}\",\"from\":\"${TERMII_SENDER_ID:-CoopEngine}\",\"type\":\"plain\",\"channel\":\"generic\",\"message\":\"Co-opEngine connectivity test — please ignore.\"}" 2>/dev/null || echo '')
    if printf '%s' "$SEND" | grep -qi 'message_id'; then
      echo "  test SMS: SENT to ${TERMII_TEST_PHONE}"
    else
      echo "  test SMS: FAILED ($(printf '%s' "$SEND" | head -c 120))"
      FAILED=1
    fi
  else
    echo "  test SMS: skipped (set TERMII_TEST_PHONE to send one)"
  fi
fi

# --------------------------------------------------------------- Monnify
echo
echo "== Monnify =="
BASE="${MONNIFY_BASE_URL:-https://api.monnify.com}"
if [ -z "${MONNIFY_API_KEY:-}" ] || [ -z "${MONNIFY_SECRET_KEY:-}" ]; then
  echo "  SKIP: MONNIFY_API_KEY / MONNIFY_SECRET_KEY not set"
else
  echo "  base: $BASE"
  echo "  api key: $(mask "$MONNIFY_API_KEY")  contract: ${MONNIFY_CONTRACT_CODE:-<unset>}"
  AUTH=$(curl -sS --max-time 20 -X POST "${BASE}/api/v1/auth/login" \
    -H "Authorization: Basic $(printf '%s:%s' "$MONNIFY_API_KEY" "$MONNIFY_SECRET_KEY" | base64 -w0)" 2>/dev/null || echo '')
  if printf '%s' "$AUTH" | grep -q 'accessToken'; then
    echo "  auth: OK (access token received)"
  else
    echo "  auth: FAILED"
    FAILED=1
  fi
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "preflight: no failures (skips are not failures)"
else
  echo "preflight: FAILURES present — fix before switching providers"
fi
exit "$FAILED"
