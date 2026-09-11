#!/usr/bin/env bash
# One-command verification, mirroring CI: typecheck, unit tests, integration
# tests, and the full build. Prints a PASS/FAIL summary and exits non-zero if
# anything failed — so a green summary can be trusted.
#
#   scripts/verify-all.sh            # everything
#   scripts/verify-all.sh --fast     # skip integration tests
set -uo pipefail
cd /root/CoopEngine-core
FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

DBURL="$(grep '^DATABASE_URL=' /root/coopengine/api.env 2>/dev/null | cut -d= -f2- || true)"
FAILED=()

step() { printf '\n=== %s ===\n' "$1"; }

step "typecheck"
if pnpm typecheck >/tmp/verify-typecheck.log 2>&1; then echo "ok"; else echo "FAILED"; tail -20 /tmp/verify-typecheck.log; FAILED+=("typecheck"); fi

step "unit tests"
if pnpm test >/tmp/verify-unit.log 2>&1; then
  grep -E "Test Files|Tests " /tmp/verify-unit.log | tail -2
else
  echo "FAILED"; grep -aE "×|FAIL" /tmp/verify-unit.log | head -10; FAILED+=("unit tests")
fi

if [ "$FAST" -eq 0 ]; then
  step "integration tests (real PostgreSQL)"
  # CI runs these per package, with the app role's DATABASE_URL.
  if [ -n "$DBURL" ]; then
    if DATABASE_URL="$DBURL" pnpm --filter @coopengine/db test:integration >/tmp/verify-integration-db.log 2>&1; then
      grep -aE "Test Files|Tests " /tmp/verify-integration-db.log | tail -2
    else
      echo "FAILED (db)"; grep -aE "×|AssertionError" /tmp/verify-integration-db.log | head -8; FAILED+=("db integration")
    fi
    if DATABASE_URL="$DBURL" pnpm --filter @coopengine/api test:integration >/tmp/verify-integration-api.log 2>&1; then
      grep -aE "Test Files|Tests " /tmp/verify-integration-api.log | tail -2
    else
      echo "FAILED (api)"; grep -aE "×|AssertionError" /tmp/verify-integration-api.log | head -12; FAILED+=("api integration")
    fi
  else
    echo "skipped (no DATABASE_URL)"
  fi
fi

step "build (all workspaces)"
if pnpm build >/tmp/verify-build.log 2>&1; then
  echo "ok"
else
  echo "FAILED"; grep -aE "Failed|error|Type error|ELIFECYCLE" /tmp/verify-build.log | head -12; FAILED+=("build")
fi
grep -aE "^ Tasks:" /tmp/verify-build.log || true

step "schema"
if [ -n "$DBURL" ]; then
  psql "$DBURL" -At -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relrowsecurity and c.relforcerowsecurity and c.relkind='r'" 2>/dev/null | xargs echo "FORCE RLS tables:"
fi
psql "$DBURL" -At -c "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null | xargs echo "migrations applied:"

printf '\n================ SUMMARY ================\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "ALL GREEN"
  exit 0
fi
echo "FAILED: ${FAILED[*]}"
exit 1
