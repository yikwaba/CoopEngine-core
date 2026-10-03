#!/usr/bin/env bash
set -euo pipefail
# Runs only against this Compose project's new PostgreSQL volume.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=owner_password="$STAGING_OWNER_PASSWORD" --set=app_password="$STAGING_APP_PASSWORD" <<'SQL'
CREATE ROLE staging_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'owner_password';
CREATE ROLE staging_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
CREATE DATABASE coopengine_staging OWNER staging_owner;
REVOKE CONNECT ON DATABASE coopengine_staging FROM PUBLIC;
GRANT CONNECT ON DATABASE coopengine_staging TO staging_owner, staging_app;
SQL
