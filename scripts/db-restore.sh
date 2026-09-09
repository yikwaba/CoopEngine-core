#!/usr/bin/env bash
# Co-opEngine database restore (local dev, via the postgres superuser).
#
# Usage: ./scripts/db-restore.sh /root/coopengine/backups/coopengine_YYYYmmdd_HHMMSS.dump
# Recreates the coopengine database and restores the custom-format dump
# (owners preserved; RLS + trigger definitions come back with the schema).
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <dump-file>" >&2
  exit 1
fi
DUMP="$1"
[[ -f "${DUMP}" ]] || { echo "Dump not found: ${DUMP}" >&2; exit 1; }

echo "Restoring ${DUMP} — the coopengine database will be dropped and recreated."
read -r -p "Type 'restore' to continue: " CONFIRM
[[ "${CONFIRM}" == "restore" ]] || { echo "Aborted."; exit 1; }

sudo -u postgres psql -c "DROP DATABASE IF EXISTS coopengine;"
sudo -u postgres psql -c "CREATE DATABASE coopengine OWNER coopengine;"
sudo -u postgres pg_restore --no-owner --clean -d coopengine "${DUMP}"
echo "Restore complete. Verify RLS + the balanced-journal trigger:"
echo "  cd packages/db && pnpm db:force-rls   (idempotent, safe to re-run)"
