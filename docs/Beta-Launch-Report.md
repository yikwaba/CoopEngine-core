# Co-opEngine — Beta Launch Report

**Date:** 10 September 2026
**Phases completed:** A (pre-flight) · B (credential rotation) · C (Supabase migration) · D (provider wiring — keys pending) · **E (TLS proxy + launch)**

---

## 1. The beta is live

| Role | Public URL |
| --- | --- |
| Staff portal | **https://app.169.58.196.141.nip.io** |
| Member PWA | **https://member.169.58.196.141.nip.io** |
| API (Swagger at `/docs`) | **https://api.169.58.196.141.nip.io/api/v1** |

Hostnames are `nip.io` names bound to this VPS address, which gives **real Let's
Encrypt certificates with no domain purchase**. Swapping in a custom domain later
is a three-line change (Caddyfile site addresses + `CORS_ORIGINS`), followed by a
web-app rebuild.

## 2. Architecture now running

```
Internet ─▶ Caddy :80/:443 (TLS, HSTS, security headers, access logs)
              ├── api.<host>    → API        :3999   systemd user unit
              ├── app.<host>    → portal     :3100   systemd user unit
              └── member.<host> → member PWA :3200   systemd user unit

Nightly timers  ├── 02:17 database backup
                ├── 06:15 loan arrears auto-default
                └── 06:30 contribution sweep + notification dispatch
```

All units are **enabled with linger on**, so the whole stack returns after a
reboot without anyone logging in. Caddy renews certificates automatically.

## 3. Verification performed

| Check | Result |
| --- | --- |
| Certificates (all three hosts) | ✅ issued by Let's Encrypt, valid to **9 Dec 2026** |
| `GET https://api…/health` | ✅ `{"status":"ok","service":"coopengine-api"}` |
| Swagger `/docs/` | ✅ 200 |
| Portal routes (/, members, loans, products, analytics, documents, branches, notifications) | ✅ all 200 over HTTPS |
| Member PWA (/, loans, manifest, service worker) | ✅ all 200 over HTTPS |
| Security headers | ✅ HSTS 1 year + includeSubDomains · nosniff · X-Frame-Options DENY · Referrer-Policy · Permissions-Policy · `Server` stripped |
| CORS preflight from the portal origin | ✅ 204 |
| Real admin login over HTTPS | ✅ 200 with token |
| HTTP → HTTPS | ✅ 308 redirect |
| **Full money loop over public HTTPS** (5 members → payroll → savings → shares → loan ₦40,000 → repayment → reconciliation **3/3, 0 mismatches** → reports → **trial balance ₦0** → member OTP dashboard) | ✅ DEMO COMPLETE |

## 4. Security posture

* **31 FORCE-RLS tables**; every tenant predicate null-safe
  (`nullif(current_setting('app.tenant_id', true), '')::uuid`) — a blank GUC can
  never leak rows or raise an error.
* Cross-tenant cron enumeration uses a **single narrow SELECT-only policy** on
  `organizations`, activated only by a transaction-local flag the internal
  workers set; tenant-facing paths never set it.
* Machine endpoints are guarded by `INTERNAL_CRON_TOKEN` (root-only `api.env`).
* **No credentials in git**: pushes use an SSH deploy key; the PAT and
  `~/.git-credentials` are gone; dev secrets, seeded admin password and Gmail app
  password were rotated in Phase B and live in root-only files.
* HTTPS everywhere with HSTS; the API is not exposed on a bare port.

## 5. What remains before full production

1. **Provider keys** — Termii (SMS) and Monnify (payments) values into
   `/root/coopengine/providers.env`. The delivery and payment code paths are
   already wired and mock-proven; the switch is
   `scripts/provider-switch.sh both`, preceded by `scripts/provider-preflight.sh`.
2. **One-month gate** — keep local Postgres as the warm fallback until a full
   month of ledger operations reconciles at **0 mismatches**, then retire it.
3. **Custom domain** (optional) — when you have one, point DNS at this VPS and
   follow the swap steps in `docs/deploy.md`.
4. **Operational hardening** (optional) — fail2ban jail over Caddy access logs;
   offsite copies of the nightly dumps and the KYC `uploads/` directory.
5. **Demo tenants** — the rehearsal created demo cooperatives on the local
   database (e.g. `demo-vv6itg`). Delete them, or keep one as a sandbox
   (`scripts/seed-demo.sh` recreates one any time).

## 6. Pointers

* Operations & env reference: `docs/deploy.md` (Phase E section)
* Cloud migration + RLS lessons: `docs/supabase-migration.md`
* Feature coverage, sprints 25–31: `Co-opEngine_Coverage_v4.docx` / `.pdf`
* Demo seeder: `scripts/seed-demo.sh`
* Acceptance rehearsal: `/root/coopengine/acceptance-run.sh`
* Units and proxy config: `docs/systemd/`, `docs/tls/Caddyfile`
