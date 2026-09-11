#!/usr/bin/env bash
# Build (or rebuild) the showcase cooperative used for testing and demos.
#
#   scripts/seed-showcase.sh                     # reset + seed against the live API
#   API_BASE=http://localhost:3999/api/v1 scripts/seed-showcase.sh
#
# Resets the tenant first so the printed logins stay the same every run.
# DESTRUCTIVE for that one tenant only — never for any other organisation.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=/root/coopengine/api.env
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }

if [ -z "${ADMIN_PASSWORD:-}" ] && [ -r /root/coopengine/admin-password ]; then
  ADMIN_PASSWORD="$(tr -d '\r\n' < /root/coopengine/admin-password)"
  export ADMIN_PASSWORD
fi

: "${API_BASE:=http://localhost:3999/api/v1}"
export API_BASE
SLUG="${SHOWCASE_SLUG:-sunrise}"

if ! curl -fsS --max-time 10 "${API_BASE}/health" >/dev/null 2>&1; then
  echo "No API answering at ${API_BASE}." >&2
  exit 1
fi

echo "Resetting the '${SLUG}' tenant (other organisations are untouched) …"
# The application role is subject to FORCE row-level security, so its DELETE would
# match zero rows and silently leave the tenant in place. Use the superuser.
PGURL="${DATABASE_URL:?DATABASE_URL must be set (api.env)}"
DBNAME="${PGURL##*/}"
DBNAME="${DBNAME%%\?*}"
if sudo -n true 2>/dev/null || [ "$(id -u)" -eq 0 ]; then
  # org_lookups has no FK to organizations, so the slug outlives the tenant and
  # onboarding would keep refusing it. Clear both, in one transaction.
  sudo -u postgres psql -d "$DBNAME" -v ON_ERROR_STOP=1 -c "
    BEGIN;
    DELETE FROM org_lookups WHERE slug = '${SLUG}';
    DELETE FROM organizations WHERE slug = '${SLUG}';
    -- users are global (not org-scoped), so onboarding would refuse to re-invite them
    DELETE FROM users WHERE email IN (
      'manager@sunrise.coop', 'treasurer@sunrise.coop',
      'loans@sunrise.coop', 'auditor@sunrise.coop'
    );
    COMMIT;" >/dev/null
else
  echo "  (cannot use the postgres superuser here; skipping the reset)" >&2
fi
left=$(sudo -u postgres psql -d "$DBNAME" -At -c "SELECT count(*) FROM organizations WHERE slug = '${SLUG}'")
if [ "$left" != "0" ]; then
  echo "  reset FAILED — tenant still present" >&2
  exit 1
fi
echo "  reset done"

cd "$REPO_ROOT"
node scripts/showcase.mjs 2>&1 | tee /tmp/showcase-seed.log

# Keep the logins where only root can read them.
OUT=/root/coopengine/showcase-logins.txt
{
  echo "Co-opEngine showcase logins (regenerate: scripts/seed-showcase.sh)"
  echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sed -n '/Logins for testing:/,$p' /tmp/showcase-seed.log
} > "$OUT"
chmod 600 "$OUT"
echo
echo "Logins saved to $OUT (mode 600)."
