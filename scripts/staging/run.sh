#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
command -v docker >/dev/null || { echo 'Docker Engine with Compose v2 is required on the staging host.' >&2; exit 1; }
docker compose version >/dev/null
stage_docker_major=$(docker version --format '{{.Server.Version}}' | cut -d. -f1)
[[ "$stage_docker_major" =~ ^[0-9]+$ ]] && (( stage_docker_major >= 28 )) || { echo 'Docker Engine 28+ is required for loopback binding protection.' >&2; exit 1; }
node scripts/staging/prepare.mjs
# Never source production api.env, providers.env or host DATABASE_URL.
# Rendered config contains credentials; do not print or share it.
docker compose --project-name coopengine-recovery-staging --env-file .staging/compose.env -f staging/compose.yml config --quiet
docker compose --project-name coopengine-recovery-staging --env-file .staging/compose.env -f staging/compose.yml up --build -d
printf 'Staging started; verify fixture and container results before accepting REC-01.\n'
printf 'Staff http://localhost:4310 | Member http://localhost:4320 | API http://localhost:4399/api/v1\n'
