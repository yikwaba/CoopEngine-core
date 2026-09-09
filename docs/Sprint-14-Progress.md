# Co-opEngine — Sprint 14 Progress & PRD Coverage

**Platform:** Multi-tenant cooperative fintech SaaS (Nigeria)
**Stack:** Next.js portal/PWA + NestJS API + PostgreSQL (RLS) · pnpm/Turbo monorepo
**Repo:** `yikwaba/CoopEngine-core` (private) · Branch `main`
**Date:** September 2026 · Sprint 14 (sprints 1–14 shipped incrementally)

---

## 1. What has been built (14 sprints, all verified)

### Phase 1 — Platform foundation
- **Tenancy & security** (Spr. 1–2): PostgreSQL **row-level security with FORCE RLS** on 22 tenant tables via a transaction-local `app.tenant_id` GUC; cross-tenant isolation proven adversarially (guessed UUIDs, full-table scans, second-tenant double-check). SaaS staff tokens and member tokens are distinct principals.
- **Identity, RBAC, MFA** (Spr. 3–4): staff logins with rotating refresh sessions (hashed at rest, instant revocation), 35-permission/13-role catalog, org onboarding atomically inside its own RLS transaction, **TOTP MFA** challenge flow (setup → verify → challenge login), login rate limiting (5/15 min → 429).
- **Hardening** (Spr. 13): pagination + `X-Total-Count`, `x-request-id` middleware, **OpenAPI docs at `/docs`**.

### Phase 2 — Membership
- Member lifecycle (create → approve → ACTIVE/SUSPENDED → exit), per-org sequential member numbers, next-of-kin, **CSV import with preview/commit control totals**, member 360.

### Phase 3 — Shares & Loans
- Share capital purchases and **redemptions** on the ledger; loan products (Cash 15% flat / Asset finance 12.5%, 3× multiplier) with application → guarantors → approval → disbursement; **flat-interest schedules generated at disbursement**; repayment capture allocating interest-before-principal with automatic loan completion; **full member exit with payout journal** (blocked while loans open).

### Phase 4 — Double-entry ledger (the heart)
- Per-coop chart of accounts (19 baseline accounts) + OPEN monthly periods; **DRAFT → SUBMITTED → POSTED** journals with sequential numbers; append-only **reversals**; trial balance; **a database-level balance trigger** that rejects any unbalanced journal on any write path (proven by an adversarial raw-SQL test); every money movement (savings, payroll, shares, loans, payouts) auto-posts balanced journals atomically; **savings reconciliation** report proving the ledger remains the source of truth (projection vs ledger, zero mismatches).

### Phase 5 — Reporting & self-service
- Reports: savings book, loan book + **aging buckets**, member 360, contribution schedule, exited-members register (audit-backed), savings-interest preview (rate-ready accrual stub), audit-log viewer.
- **Member PWA**: OTP self-service login (dev provider returns codes; Termii-ready) and personal dashboard.

### Delivery surface
- Staff portal (login + dashboard) and member PWA; **one-command end-to-end demo** (`node scripts/demo.mjs`).

---

## 2. PRD section coverage map

| PRD area | Status |
|---|---|
| Multi-tenant orgs, isolation (PRD §20 acceptance) | ✅ FORCE RLS, adversarial tests |
| Membership (FR-006/007) | ✅ lifecycle + import + 360 |
| Savings (FR-009/010) | ✅ products, accounts, auto-posted deposits/withdrawals |
| Loans (3×, 15%, 12.5% per Decision Log) | ✅ products → approve → disburse → repayment |
| Share capital | ✅ purchases + redemptions |
| Payroll deductions (FR-020) | ✅ CSV batch → balanced journal |
| Maker-checker journals | ✅ DRAFT/SUBMIT/APPROVE-POST, reversal |
| Accounting (PRD §11) | ✅ COA, periods, trial balance, immutability guard |
| Audit trail | ✅ all money/status events |
| Reports | ✅ book/aging/schedule/exits/interests + audit viewer |
| Staff portal + member PWA | ✅ real screens against the real API |

## 3. Not yet built (next phases)
- Savings **interest accrual/posting** (stub is rate-ready), virtual accounts (Monnify), KYC (Smile), WhatsApp/USSD channel (Termii), payroll loan repayment integration, admin/user management screens, USSD/agent banking (V1-deferred by decision), Supabase production deployment + secrets rotation.

## 4. Verification baseline (this sprint)
- Pipeline: typecheck 5/5 packages · unit tests 8/8 · build 5/5 · integration **29/29 across 12 spec files** (real PostgreSQL, incl. db isolation suite).
- CI (GitHub Actions): quality job + **integration job running migrations/RLS/seed against a real Postgres 16 service container with a NOSUPERUSER app role** (RLS binds in CI) — green.
- Demo run (2026-09-09): onboard → 5 members → payroll ₦35k → savings/shares → loan ₦40k disbursed → first repayment ₦13,833.33 → outstanding ₦26,666.67 → reconciliation 3/3 → trial balance net **₦0** → member OTP dashboard.

---

## 5. Sprint 15–19 additions (coverage v2)

### 15 — Savings interest engine
Preview (`GET /savings/interest/preview`) and idempotent period-end posting
(`POST /savings/interest/post`): one balanced journal per run
(`Dr 5000 Interest on Savings / Cr 2000 Member Savings Deposits` per member,
member-linked lines, one statement), credits balances + `INTEREST`
projections, requires an OPEN ledger period, 409 on double-post. Schema v14:
`savings_interest_postings` (23 tenant tables under FORCE RLS).

### 16 — Termii OTP + staff user administration
Member OTPs route through the Termii SMS API behind
`MEMBER_OTP_PROVIDER=termii` (dev provider unchanged for tests; verification
stays local hash-compare with attempt limiting). Staff users API
(`users.manage`): invite with org-template roles + one-time temp password,
role replacement, suspend/reactivate with session revocation, self-change and
last-COOP_ADMIN guards.

### 17 — Portal deep-dive + endpoint hardening
Portal: members search/pagination table, member detail 360 with
deposit/withdraw and approve/suspend/exit, users management. API: member `?q`
search, limit/offset + `X-Total-Count` on journals/loans/audit lists,
production env sweep (JWT secret required in prod, CORS allow-list).

### 18 — Loans workspace + interest-run UI
Portal `/loans` (status-filtered, approve/disburse/record-repayment capturing
the earliest unpaid installment) and `/interest` (preview → post with
per-account accrual table). Loan list rows carry memberNo/memberName. Member
PWA: refresh, friendlier transaction labels.

### 19 — Production-readiness
`scripts/start-stack.sh` (one-command API + portal + PWA), systemd USER
service for the API (validated active + healthy on the VPS), `docs/deploy.md`
(env table, Supabase/Termii wiring, rotation checklist), and an OpenAPI
contract test pinning 25 routes in the generated spec.

### Verification baseline (coverage v2)
typecheck 5/5 · unit 8/8 · build 5/5 · integration 32/32 across 15 spec files
(real PostgreSQL) · CI green (quality + integration with a NOSUPERUSER app
role) · full-stack demo run green against the live systemd API (2026-09-09):
onboard → 5 members → payroll ₦35k → savings/shares → loan ₦40k disbursed →
repayment ₦13,833.33 → outstanding ₦26,666.67 → reconciliation 3/3 →
trial balance net ₦0 → member OTP dashboard.
