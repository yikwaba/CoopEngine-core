#!/usr/bin/env bash
# Switch live providers on/off for the Co-opEngine API and restart the service.
#
#   bash scripts/provider-switch.sh termii     # SMS OTP via Termii
#   bash scripts/provider-switch.sh monnify    # real/sandbox virtual accounts
#   bash scripts/provider-switch.sh both
#   bash scripts/provider-switch.sh off        # back to dev providers
#
# Credentials live in /root/coopengine/providers.env (root-only, never printed).
set -euo pipefail
MODE="${1:?usage: provider-switch.sh termii|monnify|both|off}"
ENV_FILE=/root/coopengine/providers.env
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

set_flag() { # set_flag KEY VALUE
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

case "$MODE" in
  termii)  set_flag MEMBER_OTP_PROVIDER termii ;;
  monnify) set_flag MONNIFY_PROVIDER monnify ;;
  both)    set_flag MEMBER_OTP_PROVIDER termii; set_flag MONNIFY_PROVIDER monnify ;;
  off)     set_flag MEMBER_OTP_PROVIDER dev;    set_flag MONNIFY_PROVIDER dev ;;
  *) echo "unknown mode: $MODE" >&2; exit 1 ;;
esac
echo "providers.env updated (mode: $MODE)"

export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user restart coopengine-api
sleep 3
echo "service: $(systemctl --user is-active coopengine-api)"
echo "health: $(curl -s http://localhost:3999/api/v1/health | head -c 70)"
echo
echo "Configured flags:"
grep -E '^(MEMBER_OTP_PROVIDER|MONNIFY_PROVIDER)=' "$ENV_FILE" | sed 's/^/  /'
