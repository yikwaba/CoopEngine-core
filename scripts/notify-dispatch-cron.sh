#!/usr/bin/env bash
# Co-opEngine nightly notification dispatch.
#
# Flushes queued notifications for every tenant through the internal endpoint
# (SMS via Termii when TERMII_API_KEY is set, email via SMTP when configured,
# otherwise the dev adapter records the attempt).
set -euo pipefail

ENV_FILE=/root/coopengine/api.env
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a
: "${DATABASE_URL:?DATABASE_URL must be set}"

TOKEN="${INTERNAL_CRON_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "INTERNAL_CRON_TOKEN not set in $ENV_FILE — skipping dispatch"
  exit 0
fi
PORT="${PORT:-3999}"

# 1. Queue contribution reminders for due standing instructions
sweep=$(curl -sS --max-time 60 -X POST "http://127.0.0.1:${PORT}/api/v1/internal/savings/sweep" \
  -H "Content-Type: application/json" \
  -H "x-internal-token: $TOKEN" -d '{}' || true)
echo "contribution sweep: $sweep"

# 2. Flush queued notifications per tenant
total=0
orgs=$(psql "$DATABASE_URL" -At -c "BEGIN; SELECT set_config('app.internal_scan', 'on', true); SELECT id FROM organizations ORDER BY created_at; COMMIT;" | grep -E '^[0-9a-f-]{36}$')
for org in $orgs; do
  result=$(curl -sS --max-time 60 -X POST "http://127.0.0.1:${PORT}/api/v1/internal/notifications/dispatch" \
    -H "Content-Type: application/json" \
    -H "x-internal-token: $TOKEN" \
    -d "{\"organizationId\":\"$org\"}" || true)
  echo "org $org: $result"
done

echo "notification dispatch complete"
