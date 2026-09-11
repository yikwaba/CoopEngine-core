#!/usr/bin/env bash
# Apply a Backblaze B2 lifecycle rule so old *file versions* expire.
#
# Why: B2 keeps every version of every object. Deleting an archive (our remote
# retention) leaves the old versions behind as hidden files, so storage would
# still grow. This rule hides and then deletes versions older than N days.
#
#   scripts/setup-b2-lifecycle.sh --days 30
#   B2_KEY_ID=… B2_APP_KEY=… B2_BUCKET=backup-bucket scripts/setup-b2-lifecycle.sh
#
# Uses the S3-compatible API (boto3) with the same B2 application key as the
# rclone remote — scope that key to this bucket.
set -euo pipefail

DAYS=30
BUCKET="${B2_BUCKET:-coopengine-offsite-backups-ng}"
PREFIX="${B2_PREFIX:-offsite-leg/}"
# while+shift, not for+shift: a for-loop keeps its original argument list, so
# "--days 30" would leave "30" to be parsed as an unknown argument.
while [ $# -gt 0 ]; do
  case "$1" in
    --days=*)   DAYS="${1#*=}" ;;
    --days)     shift; DAYS="${1:-30}" ;;
    --bucket=*) BUCKET="${1#*=}" ;;
    --prefix=*) PREFIX="${1#*=}" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

prompt_secret() {
  local label="$1" var="$2" val=""
  if [ -n "${!var:-}" ]; then return; fi
  printf '%s (hidden): ' "$label" >&2
  IFS= read -rs val
  printf '\n' >&2
  eval "$var=\$(printf '%s' \"\$val\" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
}

prompt_secret "Backblaze B2 keyID" B2_KEY_ID
prompt_secret "Backblaze B2 application key" B2_APP_KEY
[ -n "$B2_KEY_ID" ] && [ -n "$B2_APP_KEY" ] || { echo "credentials missing — aborting" >&2; exit 1; }

# boto3 lives in a dedicated venv so the system python stays untouched.
VENV=/root/.venvs/b2lifecycle
if [ ! -x "$VENV/bin/python" ]; then
  echo "creating $VENV …"
  if command -v uv >/dev/null 2>&1; then
    uv venv "$VENV" >/dev/null 2>&1
    uv pip install --python "$VENV/bin/python" boto3 >/dev/null 2>&1
  else
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install --quiet boto3
  fi
fi

echo
echo "applying lifecycle rule: bucket=$BUCKET prefix=$PREFIX expire after $DAYS days"
B2_KEY_ID="$B2_KEY_ID" B2_APP_KEY="$B2_APP_KEY" B2_BUCKET="$BUCKET" B2_PREFIX="$PREFIX" B2_DAYS="$DAYS" \
  "$VENV/bin/python" - <<'PY'
import os
import boto3
from botocore.config import Config

bucket = os.environ["B2_BUCKET"]
prefix = os.environ["B2_PREFIX"]
days = int(os.environ["B2_DAYS"])

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ.get("B2_ENDPOINT", "https://s3.eu-central-003.backblazeb2.com"),
    aws_access_key_id=os.environ["B2_KEY_ID"],
    aws_secret_access_key=os.environ["B2_APP_KEY"],
    config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
)

rule = {
    "Rules": [
        {
            "ID": f"expire-old-versions-{days}d",
            "Status": "Enabled",
            "Filter": {"Prefix": prefix} if prefix else {},
            "NoncurrentVersionExpiration": {"NoncurrentDays": days, "NewerNoncurrentVersions": 5},
            "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7},
        }
    ]
}

existing = []
try:
    existing = s3.get_bucket_lifecycle_configuration(Bucket=bucket).get("Rules", [])
except Exception as exc:  # NoSuchLifecycleConfiguration is expected the first time
    print(f"  (no existing lifecycle config: {type(exc).__name__})")

kept = [r for r in existing if r.get("ID") != rule["Rules"][0]["ID"]]
try:
    s3.put_bucket_lifecycle_configuration(Bucket=bucket, LifecycleConfiguration={"Rules": kept + rule["Rules"]})
except Exception as exc:
    print(f"  FAILED to apply the lifecycle rule: {type(exc).__name__}: {exc}")
    print("  checks: endpoint region for the bucket, key scoped to this bucket, key allowed to write bucket settings")
    raise SystemExit(1)

now = s3.get_bucket_lifecycle_configuration(Bucket=bucket).get("Rules", [])
print(f"  rules now configured: {[r.get('ID') for r in now]}")
print(f"  kept existing rules:  {[r.get('ID') for r in kept]}")
PY

echo
echo "verify in the Backblaze console: bucket → Lifecycle Settings"
echo "NOTE: adjust the endpoint_url in this script if your bucket is not in eu-central-003."
