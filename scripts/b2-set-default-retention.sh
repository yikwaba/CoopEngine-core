#!/usr/bin/env bash
# Set the Default Bucket Retention on a B2 bucket (the setting that actually makes
# new files immutable — Object Lock enabled alone does not).
#
#   scripts/b2-set-default-retention.sh --days=7 --mode=COMPLIANCE
#
# Reads the key from the rclone remote (never from the command line). Verifies the
# result by reading the configuration back.
#
# WARNING: Backblaze does not allow the lock mode or duration to be changed once
# saved, and COMPLIANCE retention cannot be bypassed by anyone (including the
# account owner) until it expires. Keep the retention SHORTER than KEEP.
set -euo pipefail
cd /root/CoopEngine-core

REMOTE="${REMOTE:-b2-coopengine}"
BUCKET="${BUCKET:-coopengine-offsite-backups-ng}"
DAYS=7
MODE=COMPLIANCE
ENDPOINT="${B2_ENDPOINT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --days=*)   DAYS="${1#*=}" ;;
    --days)     shift; DAYS="${1:-7}" ;;
    --mode=*)   MODE="${1#*=}" ;;
    --mode)     shift; MODE="${1:-COMPLIANCE}" ;;
    --bucket=*) BUCKET="${1#*=}" ;;
    --remote=*) REMOTE="${1#*=}" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$MODE" in COMPLIANCE|GOVERNANCE) ;; *) echo "mode must be COMPLIANCE or GOVERNANCE" >&2; exit 2 ;; esac
[[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "--days must be a number" >&2; exit 2; }

CONF="${RCLONE_CONFIG:-$HOME/.config/rclone/rclone.conf}"
KEY_ID="$(awk -F' = ' '/^account = /{print $2; exit}' "$CONF")"
APP_KEY="$(awk -F' = ' '/^key = /{print $2; exit}' "$CONF")"
[ -n "$KEY_ID" ] && [ -n "$APP_KEY" ] || { echo "no key found in $CONF" >&2; exit 1; }

if [ -z "$ENDPOINT" ]; then
  ENDPOINT="$(curl -sS --max-time 20 -u "${KEY_ID}:${APP_KEY}" \
      https://api.backblazeb2.com/b2api/v3/b2_authorize_account 2>/dev/null \
    | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print(((d.get("apiInfo") or {}).get("storageApi") or {}).get("s3ApiUrl") or d.get("s3ApiUrl") or "")
except Exception:
    print("")')"
fi
[ -n "$ENDPOINT" ] || { echo "could not determine the S3 endpoint" >&2; exit 1; }

echo "bucket : ${BUCKET}"
echo "endpoint: ${ENDPOINT}"
echo "setting : Default Bucket Retention = ${MODE}, ${DAYS} days"
echo

VENV=/root/.venvs/b2retention
if [ ! -x "$VENV/bin/python" ]; then
  echo "preparing a venv for boto3 (one off)..."
  python3 -m venv "$VENV" >/dev/null 2>&1 || { echo "could not create the venv" >&2; exit 1; }
  "$VENV/bin/pip" install --quiet boto3 >/dev/null 2>&1 || { echo "could not install boto3" >&2; exit 1; }
fi

B2_KEY_ID="$KEY_ID" B2_APP_KEY="$APP_KEY" B2_BUCKET="$BUCKET" B2_ENDPOINT="$ENDPOINT" \
B2_DAYS="$DAYS" B2_MODE="$MODE" "$VENV/bin/python" - <<'PY'
import os, boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["B2_ENDPOINT"],
    aws_access_key_id=os.environ["B2_KEY_ID"],
    aws_secret_access_key=os.environ["B2_APP_KEY"],
    config=Config(signature_version="s3v4"),
)
bucket = os.environ["B2_BUCKET"]
days = int(os.environ["B2_DAYS"])
mode = os.environ["B2_MODE"]

try:
    current = s3.get_object_lock_configuration(Bucket=bucket).get("ObjectLockConfiguration", {})
    default = (current.get("Rule") or {}).get("DefaultRetention") or {}
    if default:
        print(f"  a default retention already exists: {default} — leaving it untouched")
        print("  (Backblaze does not allow the mode or duration to be changed)")
        raise SystemExit(0)
    print(f"  Object Lock enabled: {current.get('ObjectLockEnabled')}, no default retention")
except SystemExit:
    raise
except Exception as exc:
    print(f"  could not read the current configuration: {type(exc).__name__}: {exc}")
    raise SystemExit(1)

try:
    s3.put_object_lock_configuration(
        Bucket=bucket,
        ObjectLockConfiguration={
            "ObjectLockEnabled": "Enabled",
            "Rule": {"DefaultRetention": {"Mode": mode, "Days": days}},
        },
    )
    print("  applied")
except Exception as exc:
    print(f"  FAILED: {type(exc).__name__}: {exc}")
    raise SystemExit(1)

after = s3.get_object_lock_configuration(Bucket=bucket).get("ObjectLockConfiguration", {})
default = (after.get("Rule") or {}).get("DefaultRetention") or {}
print(f"  verified by read-back: {default}")
PY

echo
echo "Reminder: keep KEEP (in /root/coopengine/offsite.env, currently 14) GREATER than"
echo "          ${DAYS} days, or archives cannot be pruned and the vault keeps growing."
unset APP_KEY KEY_ID
