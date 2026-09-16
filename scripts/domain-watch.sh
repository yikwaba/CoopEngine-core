#!/usr/bin/env bash
# Watch for coopengine.com.ng coming live. Silent unless the STATE CHANGES.
#
# Registry state (RDAP) tells the truth about delegation; resolvers tell us what
# the world currently sees:
#   ok        -> resolves to our VPS  (ready to switch)
#   servfail  -> delegated, but the authoritative NS are not serving the zone
#                (Cloudflare has not activated it yet)
#   nx        -> no records answer (zone active without our records, or not yet
#                delegated — check RDAP to tell them apart)
#   other     -> resolves somewhere else (wrong address)
set -uo pipefail

DOMAIN="coopengine.com.ng"
VPS_IP="169.58.196.141"
STATE_FILE="/root/coopengine/.domain-watch-state"
DOH="${DOH:-/root/coopengine/doh_a.py}"

# Classify ONE name. A failed lookup is "unknown", never a verdict — treating a
# DNS-over-HTTPS hiccup as "wrong address" is what made this watcher cry wolf.
classify() {
  local out="" i
  for i in 1 2 3; do
    out="$(python3 "$DOH" "$1" A 2>/dev/null | head -1)"
    case "$out" in
      "")              sleep 2 ;;                 # nothing at all -> retry
      error*)          sleep 2 ;;                 # transport failure -> retry
      *)               break ;;
    esac
  done
  case "$out" in
    "$VPS_IP") echo "ok" ;;
    status=2)  echo "servfail" ;;
    status=3)  echo "nx" ;;
    status=*)  echo "other" ;;
    ""|error*) echo "unknown" ;;
    *)         echo "other" ;;
  esac
}

APEX="$(classify "$DOMAIN")"
API="$(classify "api.$DOMAIN")"
APP="$(classify "app.$DOMAIN")"
MEMBER="$(classify "member.$DOMAIN")"

COUNTS="$APEX $API $APP $MEMBER"
OK_N=$(printf '%s\n' $COUNTS | grep -c '^ok$' || true)
OTHER_N=$(printf '%s\n' $COUNTS | grep -c '^other$' || true)
SERVFAIL_N=$(printf '%s\n' $COUNTS | grep -c '^servfail$' || true)
UNKNOWN_N=$(printf '%s\n' $COUNTS | grep -c '^unknown$' || true)

if [ "$OK_N" -eq 4 ]; then
  state="ready"
elif [ "$OTHER_N" -ge 2 ] || [ "$SERVFAIL_N" -ge 2 ]; then
  # something is genuinely wrong for at least two names
  state="delegated"
elif [ "$UNKNOWN_N" -gt 0 ] && [ "$OK_N" -gt 0 ]; then
  # we could not see everything, but what we saw was fine: say nothing
  state="indeterminate"
else
  state="none"
fi

prev="$(cat "$STATE_FILE" 2>/dev/null || echo unknown)"
[ "$state" = "$prev" ] && exit 0
if [ "$prev" = "unknown" ] && [ "$state" = "none" ]; then
  printf '%s\n' "$state" > "$STATE_FILE"; exit 0
fi
was_ready=0
[ "$prev" = "ready" ] && was_ready=1
printf '%s\n' "$state" > "$STATE_FILE"

# "ready" means the domain is answering normally — the switchover it used to announce
# was completed on 13 September, so there is nothing to say. Silence here.
if [ "$state" = "ready" ] || [ "$state" = "indeterminate" ]; then
  exit 0
fi

case "$state" in
  delegated)
    cat <<EOF
🌐 coopengine.com.ng is not resolving to this server (it should).

  @ ${APEX} · api ${API} · app ${APP} · member ${MEMBER}
  (servfail = the zone's nameservers are not serving it · other = answering from elsewhere)

Two or more names resolve somewhere other than ${VPS_IP}. Check that the A records
for @, www, api, app and member still point at it (Cloudflare → DNS, DNS only),
and that no record has been switched back to Proxied.
EOF
    ;;
  none)
    if [ "$was_ready" -eq 1 ]; then
      cat <<EOF
⚠️ coopengine.com.ng has STOPPED resolving (it was working) — check the registrar and the Cloudflare zone.
EOF
    else
      cat <<EOF
ℹ️ coopengine.com.ng: names delegated but no A records answer yet
(@ ${APEX} · api ${API} · app ${APP} · member ${MEMBER}).

Either Cloudflare is still activating the zone, or the A records are missing in it.
Registry truth: https://rdap.nic.net.ng/domain/coopengine.com.ng
EOF
    fi
    ;;
esac
