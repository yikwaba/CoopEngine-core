#!/usr/bin/env bash
# Co-opEngine full-stack local runner: API + staff portal + member PWA.
#
# Usage:
#   ./scripts/start-stack.sh            # build (if needed) and start all three
#   STACK_SKIP_BUILD=1 ./scripts/start-stack.sh   # assume dist/.next are fresh
#
# Prereqs: local PostgreSQL 16 running with the coopengine database migrated
# and seeded (see docs/deploy.md); pnpm installed.
set -euo pipefail
cd "$(dirname "$0")/.."

API_PORT="${API_PORT:-3999}"
PORTAL_PORT="${PORTAL_PORT:-3100}"
PWA_PORT="${PWA_PORT:-3200}"
API_ENV_FILE="${API_ENV_FILE:-/root/coopengine/api.env}"
API_BASE="http://localhost:${API_PORT}/api/v1"

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

if [[ -f "${API_ENV_FILE}" ]]; then
  log "Loading API environment from ${API_ENV_FILE}"
  set -a; # shellcheck disable=SC1090
  source "${API_ENV_FILE}"; set +a
fi
export DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required (see api.env / deploy.md)}"

if [[ "${STACK_SKIP_BUILD:-0}" != "1" ]]; then
  log "Building packages"
  pnpm build
fi

log "Starting Co-opEngine API on :${API_PORT}"
(
  cd apps/api
  PORT="${API_PORT}" exec node dist/main.js
) &
API_PID=$!

log "Starting staff portal on :${PORTAL_PORT}"
(
  cd apps/portal
  NEXT_PUBLIC_API_URL="${API_BASE}" exec pnpm start
) &
PORTAL_PID=$!

log "Starting member PWA on :${PWA_PORT}"
(
  cd apps/member-pwa
  NEXT_PUBLIC_API_URL="${API_BASE}" exec pnpm start
) &
PWA_PID=$!

cleanup() {
  log "Stopping stack (API ${API_PID}, portal ${PORTAL_PID}, PWA ${PWA_PID})"
  kill "${API_PID}" "${PORTAL_PID}" "${PWA_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait for the API to be healthy (max ~15s)
for _ in $(seq 1 30); do
  if curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
    log "Stack is up"
    echo "  API    : http://localhost:${API_PORT}/api/v1  (docs: http://localhost:${API_PORT}/docs)"
    echo "  Portal : http://localhost:${PORTAL_PORT}"
    echo "  PWA    : http://localhost:${PWA_PORT}"
    echo "  Ctrl-C to stop everything"
    wait
    break
  fi
  sleep 0.5
done
