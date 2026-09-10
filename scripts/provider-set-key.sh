#!/usr/bin/env bash
# Co-opEngine secure provider-key entry.
#
#   scripts/provider-set-key.sh TERMII_API_KEY
#   scripts/provider-set-key.sh MONNIFY_SECRET_KEY
#
# The value is read from a hidden prompt (or piped stdin), trimmed, validated and
# written straight into the root-only providers.env — it is never echoed, never
# passed on the command line, and never lands in your shell history.
#
#   echo "$KEY" | scripts/provider-set-key.sh TERMII_API_KEY    # non-interactive
set -euo pipefail

KEY_NAME="${1:?usage: provider-set-key.sh <VARIABLE_NAME>}"
ENV_FILE="${PROVIDERS_ENV:-/root/coopengine/providers.env}"

case "$KEY_NAME" in
  TERMII_API_KEY|TERMII_SENDER_ID|TERMII_TEST_PHONE|TERMII_BASE_URL|TERMII_CHANNEL|\
  MONNIFY_API_KEY|MONNIFY_SECRET_KEY|MONNIFY_CONTRACT_CODE|MONNIFY_BASE_URL|MONNIFY_TIMEOUT_MS) ;;
  *) echo "refusing to write unknown variable: $KEY_NAME" >&2
     echo "allowed: TERMII_API_KEY TERMII_SENDER_ID TERMII_TEST_PHONE TERMII_BASE_URL TERMII_CHANNEL MONNIFY_API_KEY MONNIFY_SECRET_KEY MONNIFY_CONTRACT_CODE MONNIFY_BASE_URL MONNIFY_TIMEOUT_MS" >&2
     exit 2 ;;
esac

if [ -t 0 ]; then
  printf 'Paste %s (hidden, then Enter): ' "$KEY_NAME" >&2
  IFS= read -rs VALUE
  printf '\n' >&2
else
  VALUE="$(cat)"
fi

# Trim surrounding whitespace and any CR that a Windows paste adds.
VALUE="$(printf '%s' "$VALUE" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

if [ -z "$VALUE" ]; then
  echo "empty value — nothing written" >&2
  exit 1
fi

# Sanity checks per variable class (shape only; never printed on failure).
if printf '%s' "$KEY_NAME" | grep -qE '_API_KEY$|_SECRET_KEY$'; then
  if [ "${#VALUE}" -lt 12 ]; then
    echo "$KEY_NAME looks too short (${#VALUE} chars) — refusing to write it" >&2
    exit 1
  fi
fi
if [ "$KEY_NAME" = "MONNIFY_BASE_URL" ] || [ "$KEY_NAME" = "TERMII_BASE_URL" ]; then
  if ! printf '%s' "$VALUE" | grep -qE '^https://'; then
    echo "$KEY_NAME must start with https:// — refusing to write it" >&2
    exit 1
  fi
fi
if [ "$KEY_NAME" = "TERMII_SENDER_ID" ] && [ "${#VALUE}" -gt 11 ]; then
  echo "warning: Termii sender IDs are at most 11 characters — writing anyway" >&2
fi

touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
cp "$ENV_FILE" "$TMP"
if grep -qE "^${KEY_NAME}=" "$TMP"; then
  sed -i "s|^${KEY_NAME}=.*|${KEY_NAME}=${VALUE}|" "$TMP"
  ACTION=updated
else
  printf '%s=%s\n' "$KEY_NAME" "$VALUE" >> "$TMP"
  ACTION=added
fi
chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"

# Masked confirmation only.
if [ "${#VALUE}" -le 8 ]; then MASKED='****'; else MASKED="${VALUE:0:4}…${VALUE: -4}"; fi
echo "$KEY_NAME $ACTION in $ENV_FILE (value: ${MASKED}, ${#VALUE} chars)"
echo "next: scripts/provider-preflight.sh   then: scripts/provider-switch.sh termii|monnify|both"
