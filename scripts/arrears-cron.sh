#!/usr/bin/env bash
# Co-opEngine nightly arrears automation.
#
# Marks DISBURSED loans as DEFAULTED when any unpaid installment is more than
# 90 days past due — per tenant, with an audit entry. Runs as the app role with
# the tenant GUC set, so FORCE RLS still applies.
#
# Usage: ./scripts/arrears-cron.sh [daysLate]
set -euo pipefail

DAYS="${1:-90}"
ENV_FILE=/root/coopengine/api.env
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a
: "${DATABASE_URL:?DATABASE_URL must be set}"

total=0
orgs=$(psql "$DATABASE_URL" -At -c "BEGIN; SELECT set_config('app.internal_scan', 'on', true); SELECT id FROM organizations ORDER BY created_at; COMMIT;" | grep -E '^[0-9a-f-]{36}$')
for org in $orgs; do
  marked=$(psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 \
    -c "SELECT set_config('app.tenant_id', '$org', false)" \
    -c "WITH d AS (
          UPDATE loans SET status = 'DEFAULTED'
           WHERE status = 'DISBURSED'
             AND EXISTS (SELECT 1 FROM loan_repayments r
                          WHERE r.loan_id = loans.id AND r.status <> 'PAID'
                            AND (now()::date - r.due_date) > $DAYS)
           RETURNING id)
        INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, metadata)
        SELECT '$org', 'loan.status.defaulted', 'loan', id,
               jsonb_build_object('reason', 'auto: nightly arrears run', 'daysLate', $DAYS)
          FROM d
        RETURNING id" | wc -l)
  if [ "$marked" -gt 0 ]; then
    echo "org $org: defaulted $marked loan(s)"
    total=$((total + marked))
  fi
done
echo "arrears run complete: $total loan(s) defaulted at ${DAYS}+ days"
