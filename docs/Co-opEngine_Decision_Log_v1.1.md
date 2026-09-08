# CO-OPENGINE — APPROVED DECISION LOG (ADDENDUM TO TECHNICAL IMPLEMENTATION PLAN v1.0)

**Version 1.1 | September 2026 | Owner-approved decisions replacing/refining §15 defaults**

---

## Approved decisions

| # | Topic | Decision | Status |
|---|---|---|---|
| 1 | Payments | Monnify first with dedicated virtual accounts; Paystack collection adapter added later (per suggested default) | Assumed approved — no override given |
| 2 | KYC | Smile ID; store verification tokens/results only, never raw BVN/NIN | Default retained |
| 3 | Messaging/SMS | **Termii first** (SMS + WhatsApp OTP + notifications) | ✅ Approved |
| 4 | Domain | See §Domain recommendation below | Suggestion required → provided |
| 5 | Loan policy validation | 3× multiplier, 15% cash-loan, 12.5% asset-finance defaults **confirmed**; remain tenant/product-configurable | ✅ Approved |
| 6 | Chart of accounts external accountant validation | **Skipped** per owner instruction | ✅ Skipped (risk noted below) |
| 7 | USSD / Agent mode | See §USSD & agent recommendation below | Suggestion required → provided |
| 8 | RPO/RTO | Best practice: **RPO ≤ 15 min, RTO ≤ 4 h** (Supabase PITR + nightly backups + restore drills) | ✅ Approved |
| 9 | MFA policy | TOTP mandatory for all privileged roles; step-up for disbursement/reversal/journal post | Default retained |
| 10 | Repayment allocation order | penalties → fees → interest → principal, configurable per product | Default retained |
| 11 | Hosting | **Supabase** as production platform (managed PostgreSQL + RLS + Storage + PITR) | ✅ Approved (replaces self-managed PG default) |
| 12 | Auth session model | JWT short access + rotating refresh (hashed, revocable), httpOnly cookies | Default retained |
| 13 | Repo hosting/CI | GitHub private monorepo + GitHub Actions | Default retained (repo creation pending) |
| 14 | DB access library | Drizzle ORM + `pg` (works with Supabase Postgres + RLS) | Default retained |

---

## Domain recommendation

### Primary recommendation
- **Brand/root domain:** `coopengine.ng` (strong Nigerian identity; aligns with primary market and regulator/trust signals)
- **Application host:** `app.coopengine.ng`
- **Tenant subdomains:** `{slug}.app.coopengine.ng` — e.g. `nysc-coop.app.coopengine.ng` (slug unique per cooperative)
- **Email domain:** `mail.coopengine.ng` or dedicated `updates.coopengine.ng` for transactional mail so tenant replies don't mix with platform mail
- **API:** `api.coopengine.ng`

### Alternatives (if `coopengine.ng` is unavailable or too costly)
1. `coopengine.com` — best international fallback, most familiar TLD
2. `getcoopengine.com` — common SaaS convention if `.com` taken
3. `coopengine.africa` — continental positioning if expansion beyond Nigeria is planned

### Recommendation logic
- `.ng` signals local trust and fits a Nigerian cooperative audience, but requires a NIRA-accredited registrar and often a Nigerian presence — fine for this project.
- Register the chosen domain **and** its `.com` twin if affordable, to protect the brand.
- Tenant subdomain pattern keeps the SaaS operator's platform shared while every cooperative gets a clean, memorable address — matching PRD FR-001/002 and §4 tenant resolution via subdomain → slug.

**Action needed from owner:** check availability and register; provide the registrar/DNS access so Phase 0 can wire `api/app` hosts later.

---

## USSD & Agent-mode recommendation

### Recommendation: exclude from the V1 committed release — feature-flag only, revisit after pilot #1

| Option | Verdict | Reason |
|---|---|---|
| USSD (FR-046) | ❌ Do not build in V1 | Requires telco aggregator/shortcode, per-session verification design, telco cost and compliance overhead. High complexity for the "Could" priority. |
| Agent/field collection (FR-047) | ⚠️ Defer unless a pilot demands it | Useful for informal/esusu coops, but buildable later as a restricted role inside the existing Member PWA/WhatsApp flows — no new channel needed to start. |
| WhatsApp flows (FR-045) | ✅ Build (already in V1 "Should") | WhatsApp is the real low-connectivity, high-adoption channel in Nigeria; Termii covers delivery. Agents can collect via authenticated WhatsApp-assisted flow or a restricted portal view. |

### What we do now (no extra cost)
- Keep `ussd_sessions` / `agent_collections` in the schema as **feature-flagged modules** with interfaces defined but no UI build in V1.
- Define the **Field/Esusu Agent permission set** (PRD §7) in the RBAC seed so the capability is ready when switched on.
- If pilot #1 is an informal/community cooperative that needs assisted collection, we deliver **agent mode inside the Member PWA/portal** (restricted lookup + capture + receipt) — reusing tested code — before considering USSD.

### Decision for owner
**Approve: USSD deferred; agent mode available via feature flag, delivered through PWA/WhatsApp first if a pilot needs it.**

---

## Supabase implications for the architecture

- **PostgreSQL** (v15+) with RLS fully supported → our §4 strategy works unchanged (transaction-local `app.tenant_id` GUC + policies).
- **Backups/PITR** (RPO ≤ 15 min on Pro) + nightly dump → satisfies RPO/RTO decision; restore drill quarterly.
- **Supabase Storage** (S3-compatible) replaces MinIO/cloud S3 for documents/receipts → tenant-prefixed keys + signed URLs (our §9 StorageProvider interface stays; adapter targets Supabase Storage).
- **Auth:** we keep our **custom NestJS auth + MFA + RBAC** (Supabase Auth is not used for tenant-user sessions; our design needs org-scoped multi-role + maker-checker which our own layer provides). Supabase is used as database/storage platform.
- **Deploy:** API + workers + frontends still deploy to a VPS/container host (dev/staging on Contabo → prod VPS); Supabase is the managed data/storage layer, not the app host.
- **Env changes:** dev uses local docker Postgres; staging/prod point at Supabase projects (separate projects per environment).

---

## Risk register update (owner-informed)

| Risk | Status | Mitigation |
|---|---|---|
| #6 skipped — chart of accounts/recognition not validated by a Nigerian cooperative accountant before production | **Accepted by owner** | Chart stays tenant-configurable; double-entry tests enforce balance/source-linking; full accounting-policy review re-queued as a pre-GA (post-pilot) task; pilot sign-off (PRD §20) must explicitly accept the configured chart |
| USSD deferred vs PRD "Could" priority | Accepted | Feature-flagged; no contractual pilot requirement identified |
| Domain not yet registered | Open | Owner action; needed before production tenant onboarding (subdomain resolution) |
| GitHub repo not yet created | Open | Owner action or token grant; blocks Phase 0 start |

---

## Next step to start Phase 0 (Sprint 1)
1. Owner creates private GitHub repo `coopengine/coopengine` (or provides a token for me to create it).
2. Owner registers/confirms the chosen domain (can happen in parallel — not on the Phase 0 critical path).
3. Approve this decision log → I scaffold the monorepo, Docker, CI pipeline, migration baseline and test framework, then report per the iteration format (Completed / Result / Decisions / Next).
