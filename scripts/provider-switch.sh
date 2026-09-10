#!/usr/bin/env bash
# Co-opEngine provider switch — flip live providers on/off safely.
#
#   scripts/provider-switch.sh status      # what is on, and are the keys present?
#   scripts/provider-switch.sh termii      # SMS OTP through Termii
#   scripts/provider-switch.sh monnify     # virtual accounts through Monnify
#   scripts/provider-switch.sh both
#   scripts/provider-switch.sh off         # back to the dev providers
#   scripts/provider-switch.sh rollback    # restore the previous providers.env
#
# Safety rails:
#   * refuses to enable a provider whose credentials are missing (use --force to override)
#   * writes atomically (temp file + mv), mode 600, keeping one backup
#   * never prints a secret — only masked confirmations and flags
#   * restarts the API unit and verifies /health afterwards
set -euo pipefail

MODE="${1:-status}"
FORCE=0
[ "${2:-}" = "--force" ] && FORCE=1

ENV_FILE="${PROVIDERS_ENV:-/root/coopengine/providers.env}"
BACKUP="${ENV_FILE}.bak"

touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

flag() { # read a flag's current value
  local key="$1" def="${2:-dev}"
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 || true)"
  if [ -n "$line" ]; then printf '%s' "${line#*=}"; else printf '%s' "$def"; fi
}

has() { # is a variable non-empty in the env file?
  grep -qE "^$1=.+" "$ENV_FILE"
}

mask() {
  local v="$1" n=${#1}
  if [ "$n" -le 8 ]; then printf '****'; else printf '%s…%s' "${v:0:4}" "${v: -4}"; fi
}

status() {
  local otp mon
  otp="$(flag MEMBER_OTP_PROVIDER dev)"
  mon="$(flag MONNIFY_PROVIDER dev)"
  echo "providers.env : $ENV_FILE"
  echo "SMS OTP       : $otp"
  echo "Virtual accts : $mon"
  echo
  echo "credentials:"
  if has TERMII_API_KEY; then
    set -a; . "$ENV_FILE"; set +a
    echo "  TERMII_API_KEY     : $(mask "${TERMII_API_KEY:-}")"
    echo "  TERMII_SENDER_ID   : ${TERMII_SENDER_ID:-<unset>}"
  else
    echo "  TERMII_API_KEY     : <missing>"
  fi
  if has MONNIFY_API_KEY; then
    set -a; . "$ENV_FILE"; set +a
    echo "  MONNIFY_API_KEY    : $(mask "${MONNIFY_API_KEY:-}")"
    echo "  MONNIFY_CONTRACT   : $(mask "${MONNIFY_CONTRACT_CODE:-}")"
    echo "  MONNIFY_BASE_URL   : ${MONNIFY_BASE_URL:-https://api.monnify.com}"
  else
    echo "  MONNIFY_API_KEY    : <missing>"
  fi
  echo
  if [ "$otp" = "termii" ] && ! has TERMII_API_KEY; then
    echo "WARNING: SMS OTP is set to termii but TERMII_API_KEY is missing — members cannot log in."
  fi
  if [ "$mon" = "monnify" ] && ! has MONNIFY_API_KEY; then
    echo "WARNING: virtual accounts are set to monnify but MONNIFY_API_KEY is missing."
  fi
}

write_flag() { # stage a KEY=VALUE change in a temp file
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$TMP"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$TMP"
  else
    printf '%s=%s\n' "$key" "$value" >> "$TMP"
  fi
}

apply() {
  local mode="$1"
  local want_termii=0 want_monnify=0
  case "$mode" in
    termii)  want_termii=1 ;;
    monnify) want_monnify=1 ;;
    both)    want_termii=1; want_monnify=1 ;;
    off)     ;;
    *) echo "unknown mode: $mode (termii|monnify|both|off|status|rollback)" >&2; exit 1 ;;
  esac

  if [ "$want_termii" -eq 1 ] && ! has TERMII_API_KEY && [ "$FORCE" -eq 0 ]; then
    echo "refusing to enable Termii: TERMII_API_KEY is not in $ENV_FILE" >&2
    echo "  add it with: scripts/provider-set-key.sh TERMII_API_KEY" >&2
    echo "  (override with: scripts/provider-switch.sh $mode --force)" >&2
    exit 3
  fi
  if [ "$want_monnify" -eq 1 ] && ! has MONNIFY_API_KEY && [ "$FORCE" -eq 0 ]; then
    echo "refusing to enable Monnify: MONNIFY_API_KEY is not in $ENV_FILE" >&2
    echo "  add it with: scripts/provider-set-key.sh MONNIFY_API_KEY" >&2
    echo "  (override with: scripts/provider-switch.sh $mode --force)" >&2
    exit 3
  fi

  cp "$ENV_FILE" "$BACKUP"; chmod 600 "$BACKUP"
  TMP="$(mktemp)"; cp "$ENV_FILE" "$TMP"
  trap 'rm -f "$TMP"' EXIT

  case "$mode" in
    termii)  write_flag MEMBER_OTP_PROVIDER termii ;;
    monnify) write_flag MONNIFY_PROVIDER monnify ;;
    both)    write_flag MEMBER_OTP_PROVIDER termii; write_flag MONNIFY_PROVIDER monnify ;;
    off)     write_flag MEMBER_OTP_PROVIDER dev;    write_flag MONNIFY_PROVIDER dev ;;
  esac

  chmod 600 "$TMP"
  mv "$TMP" "$ENV_FILE"
  echo "providers.env updated (mode: $mode)"
  echo "previous file kept at $BACKUP (rollback: scripts/provider-switch.sh rollback)"

  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  systemctl --user restart coopengine-api
  for _ in $(seq 1 15); do
    if curl -fsS --max-time 4 http://localhost:3999/api/v1/health >/dev/null 2>&1; then break; fi
    sleep 2
  done
  echo "service: $(systemctl --user is-active coopengine-api)"
  echo "health : $(curl -s --max-time 5 http://localhost:3999/api/v1/health | head -c 70)"
  echo
  status
}

case "$MODE" in
  status) status ;;
  rollback)
    if [ ! -f "$BACKUP" ]; then echo "no backup at $BACKUP" >&2; exit 1; fi
    cp "$BACKUP" "$ENV_FILE"; chmod 600 "$ENV_FILE"
    echo "restored $ENV_FILE from $BACKUP"
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    systemctl --user restart coopengine-api
    sleep 4
    echo "service: $(systemctl --user is-active coopengine-api)"
    ;;
  termii|monnify|both|off) apply "$MODE" ;;
  *) echo "usage: provider-switch.sh status|termii|monnify|both|off|rollback [--force]" >&2; exit 1 ;;
esac
