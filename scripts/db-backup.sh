#!/usr/bin/env bash
# Co-opEngine database backup (local dev / pre-batch safety snapshot).
#
# FORCE RLS blocks pg_dump as the app role, so the dump runs as the local
# `postgres` superuser via the unix socket (peer auth, no password).
#
# Usage:
#   ./scripts/db-backup.sh                # dump to /root/coopengine/backups/
#   BACKUP_DIR=/path ./scripts/db-backup.sh
#
# Keeps the last 7 dumps. Restore with ./scripts/db-restore.sh <file>.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/lib/postgresql/backups}"
sudo -u postgres mkdir -p "${BACKUP_DIR}"

STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="${BACKUP_DIR}/coopengine_${STAMP}.dump"
sudo -u postgres pg_dump -Fc -d coopengine -f "${FILE}"
echo "Backup written: ${FILE}"

ls -1t "${BACKUP_DIR}"/coopengine_*.dump 2>/dev/null | tail -n +8 | xargs -r rm --
echo "Retention: keeping the 7 newest dumps in ${BACKUP_DIR}"
