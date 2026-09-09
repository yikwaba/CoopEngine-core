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
