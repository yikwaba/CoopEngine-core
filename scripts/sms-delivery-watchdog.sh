#!/usr/bin/env bash
# SMS delivery watchdog for Co-opEngine.
#
# Watches the failures that go unnoticed until members complain they cannot log in:
#   * a Termii wallet running dry (requests keep succeeding, nothing is delivered)
#   * a spike in undelivered login codes
#   * notification sends failing
#   * SMS switched on without credentials (a misconfiguration that would break logins)
#
# Silent when everything is healthy. Alerts when severity changes, and daily while critical.
# Usage: sms-delivery-watchdog.sh [--quiet] [--json]
set -uo pipefail

STATE_DIR="/root/coopengine/logs"
STATE_FILE="$STATE_DIR/.sms-watchdog-state"
ENV_FILE="/root/coopengine/providers.env"
ENV_API="${ENV_API:-/root/coopengine/api.env}"
QUIET=0
JSON=0
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=1 ;;
    --json) JSON=1 ;;
  esac
done

mkdir -p "$STATE_DIR"
PROBLEMS=(); NOTES=()

# ---------------------------------------------------------------- configuration
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE" 2>/dev/null; set +a; }
DBURL="${DATABASE_URL:-}"
if [ -z "$DBURL" ] && [ -f "$ENV_API" ]; then
  DBURL="$(grep '^DATABASE_URL=' "$ENV_API" | cut -d= -f2-)"
fi

OTP_PROVIDER="$(printf '%s' "${MEMBER_OTP_PROVIDER:-dev}")"
MODE="dev"
[ "$OTP_PROVIDER" = "termii" ] && MODE="live"

# ---------------------------------------------------------------- 1. consistency
if [ "$MODE" = "live" ] && [ -z "${TERMII_API_KEY:-}" ]; then
  PROBLEMS+=("SMS is switched to Termii but TERMII_API_KEY is missing — member logins will fail.")
fi

# ---------------------------------------------------------------- 2. wallet
BALANCE=""
if [ -n "${TERMII_API_KEY:-}" ]; then
  BASE="${TERMII_BASE_URL:-https://api.ng.termii.com}"
  RESP="$(curl -sS --max-time 15 "${BASE}/api/get-balance?api_key=${TERMII_API_KEY}" 2>/dev/null || true)"
  BALANCE="$(printf '%s' "$RESP" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("balance",""))
except Exception: print("")' 2>/dev/null || true)"
  if [ -z "$BALANCE" ]; then
    # A key that cannot read a balance is either wrong or revoked.
    PROBLEMS+=("Termii did not return a wallet balance — the API key may be invalid or revoked.")
  else
    LOW="$(python3 - "$BALANCE" <<'PY' 2>/dev/null || echo unknown
import sys
try:
    b = float(sys.argv[1])
    print("critical" if b <= 200 else ("warn" if b <= 1000 else "ok"))
except Exception:
    print("unknown")
PY
)"
    case "$LOW" in
      critical) PROBLEMS+=("Termii wallet is nearly empty (${BALANCE}). Top up now — login codes will stop being delivered.") ;;
      warn) NOTES+=("Termii wallet is low (${BALANCE}); consider topping up.") ;;
    esac
  fi
else
  NOTES+=("Termii is not configured yet, so SMS is in dev mode (codes shown on screen).")
fi

# ---------------------------------------------------------------- 3. delivery health
if [ -n "$DBURL" ]; then
  q() { psql "$DBURL" -At -c "$1" 2>/dev/null | tr -d ' '; }
  OTP_FAILS="$(q "SELECT count(*) FROM audit_logs WHERE action = 'member.otp.delivery_failed' AND created_at > now() - interval '24 hours'")"
  NOTIF_FAILED="$(q "SELECT count(*) FROM notifications WHERE status = 'FAILED' AND created_at > now() - interval '24 hours'")"
  NOTIF_SENT="$(q "SELECT count(*) FROM notifications WHERE status = 'SENT' AND created_at > now() - interval '24 hours'")"

  OTP_FAILS="${OTP_FAILS:-0}"; NOTIF_FAILED="${NOTIF_FAILED:-0}"; NOTIF_SENT="${NOTIF_SENT:-0}"
  if [ "$MODE" = "live" ] && [ "$OTP_FAILS" -ge 5 ] 2>/dev/null; then
    PROBLEMS+=("$OTP_FAILS login codes failed to deliver in the last 24 hours — members cannot sign in.")
  fi
  if [ "$NOTIF_FAILED" -ge 10 ] 2>/dev/null; then
    PROBLEMS+=("$NOTIF_FAILED SMS/email notifications failed in the last 24 hours (vs $NOTIF_SENT sent).")
  fi
  TOTAL=$((NOTIF_FAILED + NOTIF_SENT))
  if [ "$TOTAL" -ge 10 ] 2>/dev/null; then
    PCT=$((NOTIF_FAILED * 100 / TOTAL))
    if [ "$PCT" -ge 20 ]; then
      PROBLEMS+=("$PCT% of outbound notifications failed in the last 24 hours ($NOTIF_FAILED of $TOTAL).")
    fi
  fi
fi

# ---------------------------------------------------------------- severity + dedupe
SEVERITY="ok"
[ "${#NOTES[@]}" -gt 0 ] && SEVERITY="note"
[ "${#PROBLEMS[@]}" -gt 0 ] && SEVERITY="problem"

PREV=""; PREV_DATE=""
if [ -f "$STATE_FILE" ]; then
  PREV="$(cut -d' ' -f1 "$STATE_FILE")"
  PREV_DATE="$(cut -d' ' -f2 "$STATE_FILE")"
fi
TODAY="$(date -u +%Y-%m-%d)"
printf '%s %s\n' "$SEVERITY" "$TODAY" > "$STATE_FILE"

SHOULD_ALERT=0
if [ "$SEVERITY" = "problem" ]; then
  if [ "$PREV" != "$SEVERITY" ] || [ "$PREV_DATE" != "$TODAY" ]; then SHOULD_ALERT=1; fi
fi

if [ "$JSON" -eq 1 ]; then
  python3 - "$SEVERITY" "$MODE" "${BALANCE:-}" "$OTP_FAILS" "$NOTIF_FAILED" "$NOTIF_SENT" "${PROBLEMS[*]:-}" "${NOTES[*]:-}" <<'PY'
import json, sys
sev, mode, bal, otpf, nf, ns, probs, notes = sys.argv[1:9]
print(json.dumps({
    "severity": sev,
    "mode": mode,
    "termiiBalance": bal or None,
    "otpDeliveryFailures24h": int(otpf or 0),
    "notificationsFailed24h": int(nf or 0),
    "notificationsSent24h": int(ns or 0),
    "problems": [p for p in probs.split(" | ") if p],
    "notes": [n for n in notes.split(" | ") if n],
}, indent=2))
PY
  exit 0
fi

if [ "$QUIET" -eq 1 ] && [ "$SHOULD_ALERT" -eq 0 ]; then
  exit 0
fi

if [ "$SHOULD_ALERT" -eq 0 ] && [ "$SEVERITY" != "problem" ] && [ "$QUIET" -eq 0 ]; then
  echo "SMS delivery: healthy (mode: $MODE${BALANCE:+, wallet: $BALANCE})"
  for n in "${NOTES[@]:-}"; do [ -n "$n" ] && echo "  note: $n"; done
  exit 0
fi

if [ "$SHOULD_ALERT" -eq 1 ]; then
  echo "SMS delivery needs attention"
  echo
  for p in "${PROBLEMS[@]}"; do echo "  * $p"; done
  echo
  echo "  mode: $MODE${BALANCE:+ | wallet: $BALANCE} | failed codes (24h): ${OTP_FAILS:-0} | notifications failed/sent (24h): ${NOTIF_FAILED:-0}/${NOTIF_SENT:-0}"
  echo
  echo "  check:  bash /root/CoopEngine-core/scripts/provider-preflight.sh"
  echo "  fix:    top up the Termii wallet, or switch SMS off while you investigate:"
  echo "          bash /root/CoopEngine-core/scripts/provider-switch.sh off"
fi
exit 0
