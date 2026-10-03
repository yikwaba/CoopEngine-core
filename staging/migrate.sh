#!/usr/bin/env bash
set -euo pipefail
node scripts/staging/guard.mjs
cd /app/packages/db
pnpm db:migrate
pnpm db:force-rls
pnpm db:seed
cd /app
node scripts/staging/grants.mjs
