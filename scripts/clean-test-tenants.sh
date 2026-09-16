#!/usr/bin/env bash
# Remove test-suite cooperatives from a NON-production database.
#
#   scripts/clean-test-tenants.sh                 # dry run
#   scripts/clean-test-tenants.sh --apply         # delete them
#   scripts/clean-test-tenants.sh --keep=sunrise  # extra slugs to protect
#
# Rules live in packages/db/scripts/clean-test-tenants.mjs, which sits in the db package because
# that is where the `pg` dependency resolves from.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node packages/db/scripts/clean-test-tenants.mjs "$@"
