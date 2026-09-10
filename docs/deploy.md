# Co-opEngine — Deployment & operations guide

Local dev database (this VPS): PostgreSQL 16 at `127.0.0.1:5432`, role/db `coopengine`
(dev credentials live in `packages/db/drizzle.config.ts`, `.env.example`, and
`/root/coopengine/api.env` — never commit or echo them).

---

## 1. One-command full stack (local/VPS dev)

```bash
pnpm build                 # once (or set STACK_SKIP_BUILD=1 later)
./scripts/start-stack.sh   # loads /root/coopengine/api.env, starts:
                           #   API :3999 (+ /docs) · portal :3100 · member PWA :3200
```

Prereqs: Postgres running, migrations + RLS + seed applied:

```bash
export DATABASE_URL=postgres://coopengine:coopengine@127.0.0.1:5432/coopengine
cd packages/db && pnpm db:migrate && pnpm db:force-rls && pnpm db:seed
```

## 2. API as a systemd user service (long-running)

```bash
mkdir -p ~/.config/systemd/user
cp docs/systemd/coopengine-api.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now coopengine-api
systemctl --user status coopengine-api      # logs: journalctl --user -u coopengine-api -f
```

Rebuild + restart after a deploy:

```bash
cd /root/CoopEngine-core && pnpm build
systemctl --user restart coopengine-api
```

## 3. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | always | Postgres connection (prod: Supabase pooled URL) |
| `PORT` | no | API port (default 3000; dev 3999) |
| `NODE_ENV` | prod | `production` enables fail-fast secrets |
| `JWT_ACCESS_SECRET` | **prod** | ≥32 random chars; **boot fails without it in production** |
| `JWT_ACCESS_TTL_SECONDS` | no | default 900 |
| `REFRESH_TOKEN_TTL_DAYS` | no | default 30 |
| `CORS_ORIGINS` | no | comma list (defaults localhost:3100,3200) |
| `MEMBER_OTP_PROVIDER` | no | `dev` (returns codes, tests) or `termii` |
| `TERMII_API_KEY` | termii | Termii portal API key |
| `TERMII_SENDER_ID` | termii | approved sender/alphanumeric ID |
| `NEXT_PUBLIC_API_URL` | web apps | portal/PWA API base at build/run time |

Front-end builds: `apps/portal` & `apps/member-pwa` read `NEXT_PUBLIC_API_URL`
(defaults to `http://localhost:3999/api/v1`).

## 4. Production wiring checklist (Supabase + Termii)

1. **Supabase Postgres**: run migrations via `pnpm db:migrate` with the pooled
   `DATABASE_URL`; then `pnpm db:force-rls` (this enforces RLS on all 23 tenant
   tables and installs the balanced-journal trigger) and `pnpm db:seed` with a
   fresh SaaS-admin password (override in seed or rotate immediately).
2. **Non-superuser role**: RLS is only meaningful if the app role is
   `NOSUPERUSER` (CI does this automatically via `scripts/ci-init-db.mjs`; on
   Supabase the `postgres` role already is superuser — create an app role).
3. **Termii**: set `MEMBER_OTP_PROVIDER=termii` + keys; member rows need
   `phone` set or OTPs are not sent (response stays generic — no enumeration).
4. **CORS/JWT**: set `CORS_ORIGINS` to real portal/PWA origins and a strong
   `JWT_ACCESS_SECRET` (generate: `openssl rand -base64 48`).
5. **Serving**: run the API behind a reverse proxy (Caddy/Nginx) with TLS;
   portal/PWA can be served as static Next.js builds behind the same proxy.

## 5. Standing rotation checklist (from earlier arcs — still pending)

These credentials were pasted into chat or stored earlier and should be
rotated when convenient:

- GitHub fine-grained PATs in `~/.git-credentials` (Contents + Workflows R/W
  on CoopEngine-core) → generate new ones with the same scopes, update the
  file, revoke the old.
- Composio project/CLI keys.
- himalaya Gmail app password (Gmail account `yikwab.a@gmail.com`, read+draft
  only) → revoke in Google account settings, store new one via the
  `himalaya` config (never paste it into chat).
- Local dev secrets are **dev-only**: seeded admin password, dev JWT secret,
  and the local Postgres password — rotate before any shared deployment.

## 6. Verification baseline

- `pnpm typecheck` (5 packages) · `pnpm test` (unit) · `pnpm build` (5 packages)
- Integration: `pnpm --filter @coopengine/db test:integration` + API suite
  (`apps/api`, real PostgreSQL, `fileParallelism: false`)
- CI (GitHub Actions) runs quality + integration against a real Postgres 16
  service container with a NOSUPERUSER app role.
- E2E demo: `node scripts/demo.mjs` against a running API.


---

## Operations update — 2026-09-10

### Environment variables added since the first draft

| Variable | Where | Purpose |
| --- | --- | --- |
| `INTERNAL_CRON_TOKEN` | `api.env` (root-only) | Shared secret for the machine endpoints (`/api/v1/internal/notifications/dispatch`, `/api/v1/internal/savings/sweep`). Generated with `openssl rand -hex 24`. |
| `DOCUMENTS_DIR` | service env (default `/root/coopengine/uploads`) | On-disk root for the KYC document vault (per-tenant subfolders). Back this up with the database. |
| `DOCUMENTS_MAX_BYTES` | optional (default 5 MB) | Upload cap for member documents. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | `providers.env` | Switches the notification EMAIL channel from the dev adapter to real SMTP (nodemailer). Port 465 ⇒ implicit TLS. |
| `TERMII_BASE_URL` / `TERMII_CHANNEL` / `TERMII_TIMEOUT_MS` | `providers.env` | Termii SMS overrides (defaults: `https://api.ng.termii.com`, `generic`, 8000 ms). |
| `MONNIFY_BASE_URL` / `MONNIFY_TIMEOUT_MS` | `providers.env` | Monnify endpoint override (sandbox vs live) and request timeout. |
| `SEED_ADMIN_PASSWORD` | shell when reseeding | Overrides the seeded SaaS-admin password; the integration suite also reads it. |

`providers.env` is optional and loaded with `EnvironmentFile=-/root/coopengine/providers.env`.

### Nightly timers (systemd user units, installed and armed)

| Timer | Schedule | What it does |
| --- | --- | --- |
| `coopengine-backup.timer` | 02:17 | `pg_dump` as the local `postgres` superuser → `/var/lib/postgresql/backups` (7-dump retention). |
| `coopengine-arrears.timer` | 06:15 | Marks DISBURSED loans as DEFAULTED when any unpaid installment is 90+ days late (per tenant, RLS GUC set, audited). |
| `coopengine-notify.timer` | 06:30 | Sweeps due standing-contribution instructions (queues reminders) and flushes pending notifications (Termii SMS / SMTP email / dev adapter). |

Check with `XDG_RUNTIME_DIR=/run/user/0 systemctl --user list-timers | grep coopengine`.

### RLS lessons that matter in production

1. **Never rely on `SECURITY DEFINER` to bypass RLS.** A function owned by a role
   that is itself subject to FORCE RLS still sees nothing. Cron workers enumerate
   tenants through a narrow, `SELECT`-only `internal_scan` policy on
   `organizations` that only matches when the transaction-local flag
   `app.internal_scan = 'on'` is set (migration `0025`).
2. **Predicates must tolerate a blank GUC.** All tenant policies now use
   `nullif(current_setting('app.tenant_id', true), '')::uuid` so a missing or
   empty setting means "no rows" instead of
   `invalid input syntax for type uuid: ""` (migration `0024`).
3. **Custom migrations are the supported path** for raw SQL:
   `pnpm exec drizzle-kit generate --custom --name=...` then `pnpm db:migrate`.
   `db:force-rls` only enforces the RLS flag; it does not rewrite predicates.

### One-command demo tenant

```bash
scripts/seed-demo.sh            # against http://localhost:3999
API_BASE=https://api.example.com/api/v1 scripts/seed-demo.sh
```

Creates a fresh cooperative (unique slug) with members, deposits, share
purchases, a full loan lifecycle, a dividend run and the reconciliation +
trial-balance checks, then prints the logins to use in the portal and PWA.
