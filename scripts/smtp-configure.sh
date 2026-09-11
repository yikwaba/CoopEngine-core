#!/usr/bin/env bash
# Configure SMTP email delivery (Brevo) for Co-opEngine.
#
#   scripts/smtp-configure.sh                       # hidden prompts, writes providers.env, restarts API
#   scripts/smtp-configure.sh --key-file /root/brevo.key
#   scripts/smtp-configure.sh --status              # what is configured (never prints secrets)
#   scripts/smtp-configure.sh --test you@example.com
#   scripts/smtp-configure.sh --off                 # remove SMTP_* (back to the dev recorder)
#
# The password is never passed on the command line and never echoed.
set -euo pipefail

ENVF=/root/coopengine/providers.env
SERVICE=coopengine-api
API=http://127.0.0.1:3999/api/v1
export XDG_RUNTIME_DIR=/usr/lib/systemd/../../../run/user/$(id -u)

HOST="smtp-relay.brevo.com"
PORT="587"
USER_=""
FROM_=""
KEY_FILE=""
MODE="configure"
TEST_TO=""

for arg in "$@"; do
  case "$arg" in
    --host=*) HOST="${arg#*=}" ;;
    --port=*) PORT="${arg#*=}" ;;
    --user=*) USER_="${arg#*=}" ;;
    --from=*) FROM_="${arg#*=}" ;;
    --key-file=*) KEY_FILE="${arg#*=}" ;;
    --status) MODE="status" ;;
    --off) MODE="off" ;;
    --test) MODE="test" ;;
    --test=*) MODE="test"; TEST_TO="${arg#*=}" ;;
    *) if [ "$MODE" = "test" ] && [ -z "$TEST_TO" ]; then TEST_TO="$arg"; else echo "unknown argument: $arg" >&2; exit 2; fi ;;
  esac
done

mask() { # never print a secret
  local v="$1"
  if [ -z "$v" ]; then echo "(unset)"; elif [ ${#v} -le 8 ]; then echo "****"; else echo "${v:0:4}…${v: -2} (${#v} chars)"; fi
}

get_env() { grep -E "^$1=" "$ENVF" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

# ---------------------------------------------------------------- status
if [ "$MODE" = "status" ]; then
  echo "provider file : $ENVF ($(stat -c %a "$ENVF" 2>/dev/null || echo missing))"
  echo "SMTP_HOST     : $(get_env SMTP_HOST)"
  echo "SMTP_PORT     : $(get_env SMTP_PORT)"
  echo "SMTP_USER     : $(get_env SMTP_USER)"
  echo "SMTP_PASS     : $(mask "$(get_env SMTP_PASS)")"
  echo "SMTP_FROM     : $(get_env SMTP_FROM)"
  if [ -n "$(get_env SMTP_HOST)" ]; then
    echo "email channel : ACTIVE (real delivery)"
  else
    echo "email channel : dev recorder (notifications recorded as FAILED, no mail sent)"
  fi
  exit 0
fi

# ---------------------------------------------------------------- off
if [ "$MODE" = "off" ]; then
  cp -a "$ENVF" "$ENVF.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  grep -vE '^SMTP_' "$ENVF" > "$ENVF.tmp" && chmod 600 "$ENVF.tmp" && mv "$ENVF.tmp" "$ENVF"
  systemctl --user restart "$SERVICE"
  for i in $(seq 1 20); do
    sleep 1
    if curl -s --max-time 3 "$API/health" | grep -q '"status":"ok"'; then
      echo "SMTP_* removed — email is back to the dev recorder. Backup kept."
      exit 0
    fi
  done
  echo "WARNING: API did not report healthy within 20s — check: systemctl --user status $SERVICE" >&2
  exit 1
fi

# ---------------------------------------------------------------- test send
if [ "$MODE" = "test" ]; then
  [ -n "$TEST_TO" ] || { echo "usage: smtp-configure.sh --test <recipient>" >&2; exit 2; }
  [ -n "$(get_env SMTP_HOST)" ] || { echo "SMTP is not configured yet — run scripts/smtp-configure.sh first." >&2; exit 3; }
  cd /root/CoopEngine-core/apps/api
  SMTP_HOST="$(get_env SMTP_HOST)" SMTP_PORT="$(get_env SMTP_PORT)" \
  SMTP_USER="$(get_env SMTP_USER)" SMTP_PASS="$(get_env SMTP_PASS)" \
  SMTP_FROM="$(get_env SMTP_FROM)" TEST_TO="$TEST_TO" \
  node -e '
    const nodemailer = require("nodemailer");
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 15000,
    });
    t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: process.env.TEST_TO,
      subject: "Co-opEngine SMTP test",
      text: "If you are reading this, the Co-opEngine email leg works.\n\n"
          + "Sent through " + process.env.SMTP_HOST + " from " + (process.env.SMTP_FROM || process.env.SMTP_USER) + ".",
    }).then((info) => {
      console.log("SENT ok — provider message id:", info.messageId);
      console.log("accepted:", JSON.stringify(info.accepted), "rejected:", JSON.stringify(info.rejected));
    }).catch((e) => {
      console.error("SEND FAILED —", e.code || "", e.responseCode || "", e.message || e);
      process.exit(1);
    });
  '
  exit $?
fi

# ---------------------------------------------------------------- configure
if [ -z "$KEY_FILE" ]; then
  echo
  echo "Brevo SMTP setup. Values are read without echoing and written to"
  echo "$ENVF (mode 600). Nothing is displayed and nothing goes to the shell history."
  echo
  [ -n "$USER_" ] || { read -r -p "SMTP login (your Brevo account email): " USER_; echo; }
  read -r -s -p "SMTP key (hidden): " PASS_; echo
else
  [ -r "$KEY_FILE" ] || { echo "cannot read key file: $KEY_FILE" >&2; exit 4; }
  USER_="$(sed -n '1p' "$KEY_FILE" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  PASS_="$(sed -n '2p' "$KEY_FILE" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  echo "read login and key from $KEY_FILE"
fi

PASS_="$(printf '%s' "${PASS_}" | tr -d '\r\n')"
[ -n "$USER_" ] || { echo "SMTP login is required" >&2; exit 4; }
[ -n "$PASS_" ] || { echo "SMTP key is required" >&2; exit 4; }
[ -n "$FROM_" ] || FROM_="CoopEngine <no-reply@coopengine.com.ng>"

cp -a "$ENVF" "$ENVF.bak-$(date -u +%Y%m%dT%H%M%SZ)"
grep -vE '^SMTP_' "$ENVF" > "$ENVF.tmp" 2>/dev/null || true
{
  cat "$ENVF.tmp" 2>/dev/null || true
  echo "SMTP_HOST=${HOST}"
  echo "SMTP_PORT=${PORT}"
  echo "SMTP_USER=${USER_}"
  echo "SMTP_PASS=${PASS_}"
  echo "SMTP_FROM=${FROM_}"
} > "$ENVF.new"
chmod 600 "$ENVF.new"
mv "$ENVF.new" "$ENVF"
rm -f "$ENVF.tmp"
if [ -n "$KEY_FILE" ]; then shred -u "$KEY_FILE" 2>/dev/null || rm -f "$KEY_FILE"; echo "key file removed"; fi

echo
echo "written (mode $(stat -c %a "$ENVF")):"
echo "  SMTP_HOST = ${HOST}"
echo "  SMTP_PORT = ${PORT}"
echo "  SMTP_USER = ${USER_}"
echo "  SMTP_PASS = $(mask "$PASS_")"
echo "  SMTP_FROM = ${FROM_}"

systemctl --user restart "$SERVICE"
for i in $(seq 1 20); do
  sleep 1
  if curl -s --max-time 3 "$API/health" | grep -q '"status":"ok"'; then
    echo "API restarted and healthy — the email channel is now ACTIVE."
    echo
    echo "next: scripts/smtp-configure.sh --test your@address   (send a real message)"
    exit 0
  fi
done
echo "WARNING: API did not report healthy within 20s — check: systemctl --user status $SERVICE" >&2
exit 1
