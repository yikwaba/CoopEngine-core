# Supabase migration — dry-run checklist

Target: move the local Postgres 16 schema/data to Supabase Postgres with RLS
intact. Local dev stays on `127.0.0.1`; this checklist is the staged path.

## 0. Pre-flight (repo state)
- [ ] `main` green: typecheck 5/5 · unit 8/8 · build 5/5 · integration 32/32
- [ ] Migrations applied locally through the latest snapshot (`pnpm db:migrate`)
- [ ] `pnpm db:force-rls` output shows FORCE RLS on **23** tenant tables and the
      balanced-journal trigger installed
- [ ] `pnpm db:seed` idempotent (RBAC sync + SaaS admin)
- [ ] E2E demo green: `node scripts/demo.mjs`

## 1. Provision Supabase
- [ ] Create project (region Nigeria-ish: eu-west or eu-central), note the
      **pooled** connection string (`?pgbouncer=true&connection_limit=1`) and the
      direct/transaction URL (for migrations)
- [ ] Create the app role (RLS is meaningless under the `postgres` superuser):
      `CREATE ROLE coopengine_app LOGIN PASSWORD '<strong>' NOSUPERUSER NOCREATEDB NOCREATEROLE;`
- [ ] Grant: schema usage + DML on all tables/sequences to `coopengine_app`
      (run AFTER migrations so object grants exist)

## 2. Schema + RLS (transaction URL, NOT the pgbouncer pool)
- [ ] `DATABASE_URL=<direct-url> pnpm db:migrate` — all 0014 migrations + snapshots
- [ ] `pnpm db:force-rls` — idempotent: FORCE RLS on 23 tables, trigger install
- [ ] **Verify** with the APP role, not postgres:
      - cross-tenant isolation probe (mirror of `packages/db` tenancy spec)
      - raw unbalanced journal INSERT rejected by the trigger
      - `SELECT rolname, rolsuper` confirms app role is NOSUPERUSER

## 3. Seed & first data
- [ ] `pnpm db:seed` with a **fresh SaaS-admin password** (do not reuse the dev one)
- [ ] `JWT_ACCESS_SECRET` rotated: `openssl rand -base64 48`
- [ ] Smoke the whole journey via `scripts/demo.mjs` pointed at Supabase
      (`API_BASE` = the deployed API URL)

## 4. App configuration (deploy env)
- [ ] `DATABASE_URL` → pooled Supabase URL
- [ ] `NODE_ENV=production` (now REQUIRES `JWT_ACCESS_SECRET` — fail-fast guard)
- [ ] `CORS_ORIGINS` → real portal/PWA origins
- [ ] `MEMBER_OTP_PROVIDER=termii` + `TERMII_API_KEY` + `TERMII_SENDER_ID`
      (member rows need `phone` populated for delivery)
- [ ] `NEXT_PUBLIC_API_URL` set at portal/PWA build time

## 5. Cut-over + safety
- [ ] Keep local Postgres as a warm fallback until one full month of ledger
      operations reconciles (savings reconciliation report = 0 mismatches)
- [ ] Document RPO/RTO expectations (decision log: 15 min / 4 h)
- [ ] After cut-over, rotate every secret touched in this checklist

## 6. Standing rotation reminders (unchanged from docs/deploy.md)
GitHub fine-grained PATs · Composio project/CLI keys · himalaya Gmail app
password · dev-only secrets (seeded admin password, dev JWT, local Postgres).

---

## Executed — 2026-09-10 (beta project)

**Project:** `coopengine-beta` · ref `bvulnlywvsgbbmhwjhav` · region `eu-west-2`
(London) · Postgres 17.6 (the pre-existing personal project in the account was
left untouched).

**What was done (all verified):**
1. Dedicated **NOSUPERUSER app role** `coopengine_app` (super=false,
   createdb=false, createrole=false) with CREATE on `public` — migrations,
   tests and the app all run as this role, so FORCE RLS actually applies.
2. `pnpm db:migrate` → 18 migrations applied; `pnpm db:force-rls` → **25 tables
   FORCE RLS + balanced-journal trigger**; `pnpm db:seed` → 13 roles,
   35 permissions.
3. Isolation probe as the app role: **0 rows visible without tenant context**.
4. **Full API integration suite against Supabase: 35/35 across 18 files.**
5. **E2E demo against Supabase via the pooled URL** (`supabase-demo.sh`):
   onboard → payroll ₦35k → savings/shares → loan ₦40k → repayment → 
   reconciliation 3/3 → trial balance net ₦0 → member OTP dashboard.
6. **Restore drill**: `pg_dump` (277 KB) → restored into a local scratch DB:
   35 tables, 25 FORCE-RLS tables, roles/permissions parity.
7. Cloud SaaS admin password rotated (root-only
   `/root/coopengine/supabase-admin-password`).

**Operational notes / gotchas hit:**
- **TLS**: node-postgres ≥8.16 verifies certs; pin Supabase's CA
  (`supabase-pin-ca.sh` → `/root/coopengine/supabase-ca.crt`, Supabase Root 2021)
  and set `NODE_EXTRA_CA_CERTS` for node, `PGSSLROOTCERT` for psql/`pg_dump`.
  Use `sslmode=verify-full` in URLs.
- **Latency**: cloud round-trips exceed vitest's 5 s default — the integration
  config now uses `VITEST_TEST_TIMEOUT`/`VITEST_HOOK_TIMEOUT` (default 30 s).
- **pg_dump version**: server is PG17; local client was PG16 → installed
  `postgresql-client-17` from PGDG (`install-pg17-client.sh`).
- **Supabase `postgres` is not a superuser** — `ALTER ROLE postgres` is denied;
  rotate its password from the dashboard/Management API, not SQL.
- Scripts: `supabase-provision.sh`, `supabase-migrate.sh`, `supabase-verify.sh`,
  `supabase-tests.sh`, `supabase-demo.sh`, `supabase-restore-drill.sh`,
  `supabase-pin-ca.sh`, `supabase-admin-rotate.sh` (in `/root/coopengine/`).
- Secrets live in `/root/coopengine/supabase.env` (chmod 600; app-role URLs,
  direct + pooled). `supabase-provision.sh` / `-restore-drill.sh` now read the
  admin password from `$SUPABASE_ADMIN_PW`.


---

## Verification against the cloud database (2026-09-10)

Migration numbers that matter for the cloud cut-over:

* `0023` – `0024` – `0025`: custom SQL migrations. `0024` rebuilds every tenant
  policy with `nullif(current_setting('app.tenant_id', true), '')::uuid`;
  `0025` adds the narrow `internal_scan` SELECT policy on `organizations` used by
  the nightly cron workers (a `SECURITY DEFINER` helper cannot work there,
  because a function owned by an RLS-bound role still sees zero rows).
* Postgres **17** server vs Postgres **16** client on the VPS: install
  `postgresql-client-17` (PGDG) before running `pg_dump`, otherwise the dump
  aborts with "server version mismatch".
* TLS: `pg` >= 8.16 verifies certificates, so `sslmode=verify-full` requires the
  pinned Supabase root CA (`/root/coopengine/supabase-ca.crt`, exported as
  `NODE_EXTRA_CA_CERTS`; `PGSSLROOTCERT` for libpq/psql).
* Cloud latency: the integration suite runs with a 30 s per-test timeout against
  Supabase (Lagos → London round-trips); local runs are unaffected.
* Cloud isolation proof: with the app role (`coopengine_app`, NOSUPERUSER) the
  tenant probe sees **0 rows** without a tenant context, and the full suite
  passes on the cloud database.

### Acceptance run

`/root/coopengine/acceptance-run.sh` performs the full rehearsal on the live
stack: migrate + seed the cloud database, boot a dedicated API against the
**pooled** URL, walk the entire money loop, start the portal and PWA, probe every
route, and write evidence to `/root/coopengine/acceptance-<timestamp>.log`.
