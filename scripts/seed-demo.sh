#!/usr/bin/env bash
# Co-opEngine demo tenant seeder.
#
# Creates a complete, realistic cooperative in one command: members, savings,
# shares, a loan through its full lifecycle, a dividend run and the reports to
# prove the books balance. Safe to re-run (each run creates a fresh tenant with
# a unique slug).
#
# Usage:
#   scripts/seed-demo.sh                 # local API on :3999
#   API_BASE=… scripts/seed-demo.sh      # any running API
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=/root/coopengine/api.env
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }

# Local runs use the rotated seeded-admin password from the root-only file.
if [ -z "${ADMIN_PASSWORD:-}" ] && [ -r /root/coopengine/admin-password ]; then
  ADMIN_PASSWORD="$(tr -d '\r\n' < /root/coopengine/admin-password)"
  export ADMIN_PASSWORD
fi

: "${API_BASE:=http://localhost:3999/api/v1}"
export API_BASE

# Fail fast with a clear message when nothing is listening.
if ! curl -fsS --max-time 10 "${API_BASE}/health" >/dev/null 2>&1; then
  echo "No API answering at ${API_BASE} — start it first (scripts/start-stack.sh)." >&2
  exit 1
fi

cd "$REPO_ROOT"
echo "Seeding a demo cooperative against ${API_BASE} …"
node scripts/demo.mjs
