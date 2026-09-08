# CO-OPENGINE — TECHNICAL IMPLEMENTATION PLAN

**Version 1.0 | September 2026 | Status: For review/approval — no production code before sign-off**

Baseline inputs: Co-opEngine PRD v2.0 (September 2026) + Master Build Prompt.
Mandated stack: Next.js + TypeScript, NestJS + TypeScript modular monolith, PostgreSQL + Row-Level Security, Redis + BullMQ, S3-compatible object storage.

---

## 1. REPOSITORY / MONOREPO STRUCTURE

One GitHub monorepo, pnpm workspaces + Turborepo, strict TypeScript project references.

```
coopengine/
├── apps/
│   ├── api/                      # NestJS backend (modular monolith)
│   │   ├── src/
│   │   │   ├── modules/          # one folder per domain module (see §2)
│   │   │   ├── common/           # guards, decorators, interceptors, pipes, filters
│   │   │   ├── config/           # env validation (Joi/Zod), typed config
│   │   │   ├── database/         # DataSource, migrations, RLS policies, seeders
│   │   │   ├── workers/          # BullMQ processor entrypoints
│   │   │   └── main.ts
│   │   ├── test/                 # integration + e2e suites
│   │   └── ...
│   ├── portal/                   # Next.js — SaaS Super Admin + Cooperative Admin
│   │   └── (App Router, RBAC-aware routes, org-slug middleware)
│   └── member-pwa/               # Next.js (or Vite PWA) — Member self-service
├── packages/
│   ├── shared/                   # domain types, constants, enums, permission map
│   ├── contracts/                # Zod schemas + OpenAPI types shared FE/BE
│   ├── db/                       # drizzle schema defs, migration tooling, seeds
│   ├── ui/                       # design-system components (React)
│   ├── validation/               # shared validation schemas
│   └── config/                   # eslint, tsconfig, tailwind presets
├── docker-compose.yml            # local: postgres, redis, minio, mailpit
├── .github/workflows/            # CI/CD (§12)
└── docs/                         # ADRs, runbooks, this plan
```

**Monorepo decisions**
- pnpm workspaces; Turborepo for task caching (`lint`, `typecheck`, `test`, `build`).
- `packages/contracts` is the single source of truth: backend implements, frontend consumes typed schemas — no drift between FE/BE field names.
- Backend and frontends versioned and deployed independently (API first).
- All secrets live in environment/deploy secrets, never in the repo.

---

## 2. DOMAIN / MODULE ARCHITECTURE

NestJS **modular monolith** with strict module boundaries — one deployable, many internal modules. Each module owns its tables; cross-module data access goes through module services or internal events (never direct cross-module DB writes).

| Module | Responsibilities (PRD FR refs) |
|---|---|
| tenancy | Organizations, settings, branches, plans, subscriptions, feature flags (FR-001..003) |
| identity | Users, sessions, MFA, roles, permissions, user_roles (FR-004..005) |
| membership | Member lifecycle, employment, KYC metadata, documents, import (FR-006..008) |
| savings | Products, accounts, contributions, bulk postings, withdrawals, statements (FR-009..013) |
| shares | Share products, transactions, balances (FR-012) |
| loans | Products, templates (3×/15%/12.5%), applications, eligibility, guarantors, approvals, schedules, disbursement, repayment, arrears, restructure/payoff (FR-014..025) |
| payroll | Batches, upload/map, validation, atomic posting, reversal (FR-026..028) |
| payments | Payment intents, virtual accounts, provider transactions, webhooks, reconciliation (FR-029..032) |
| accounting | Chart of accounts, journals, reversals, periods, ledger, statements (FR-033..037) |
| approvals | Workflow engine: approval inbox, steps, actions, delegation, maker-checker (FR-038) |
| documents | Templates, generation, versions, receipts/agreements (FR-040) |
| notifications | Email/SMS/WhatsApp abstraction, delivery log, consent/preferences (FR-041) |
| reporting | Report catalog, query builders, exports PDF/XLSX/CSV (FR-042..043) |
| channels | Member PWA API, WhatsApp flows, optional USSD/agent mode (FR-044..047) |
| audit | Audit logs, access logs, support access (FR-039, FR-048) |
| saas-admin | Super-admin control centre: tenants, plans, billing, support access |
| providers | Adapter registry: payments, KYC, messaging, email, storage (§9) |

**Architecture rules**
- Controller → Service → Repository per module; DTOs validated at the edge.
- Domain events (NestJS EventEmitter/outbox) drive side effects: e.g. `ContributionPosted` → accounting journal + statement read-model + receipt + notification.
- Approval engine is generic; loan/payroll/withdrawal flows register policies against it.
- All financial write commands are routed through an `Idempotency` middleware/table first (§3, §7).
- Outbox pattern for events that must be exactly-once (notifications, webhooks out, reports).

---

## 3. POSTGRESQL ERD / SCHEMA PLAN

**Global conventions**
- Every table: `id uuid PK DEFAULT gen_random_uuid()`, `created_at`, `updated_at` (timestamptz).
- Every tenant-owned table carries `organization_id uuid NOT NULL REFERENCES organizations(id)` and is covered by RLS (§4).
- Money: `NUMERIC(19,2)` only — never float. NGN.
- Enums as PG enums or check-constrained text (prefer check-constrained text + TS union in `packages/shared` for migration flexibility).
- Unique constraints include `organization_id` wherever tenant-scoped.
- Indexes: every FK + `(organization_id, status)`, `(organization_id, member_id, created_at)`, `(organization_id, due_date)`, provider-reference unique indexes.

**Domain table map**

1. **Tenancy**: `organizations` (name, legal_name, slug UNIQUE, subdomain, status, plan_id, settings jsonb), `organization_settings`, `branches` (org-scoped), `plans`, `subscriptions` (cycle, member_limit, status, dates), `feature_flags` (plan/org scope).
2. **Identity**: `users` (global identity: email, password_hash, status), `sessions`, `mfa_methods`, `roles` (org or saas scope), `permissions`, `role_permissions`, `user_roles` (user_id, organization_id nullable, role_id, branch_id nullable) — one user, many orgs.
3. **Membership**: `members` (org, member_no unique in org, person data, status: PENDING/ACTIVE/SUSPENDED/EXITED, join date), `member_employment`, `next_of_kin`, `member_bank_accounts` (encrypted), `kyc_checks` (provider, status, result ref — never raw BVN/NIN), `member_documents`.
4. **Products**: `savings_products` (compulsory/voluntary, rules jsonb), `share_products`, `loan_products` (template: cash/asset/3x, interest method, rate, tenor, multiplier, fees, penalties, guarantor rules jsonb), `fee_rules`, `penalty_rules`.
5. **Savings/Shares**: `member_accounts` (org, member, product, balance NUMERIC), `contribution_schedules`, `savings_transactions` (type, amount, ref, journal_id), `withdrawals` (state machine), `share_transactions`.
6. **Loans**: `loan_applications` (state machine §10 PRD), `eligibility_results` (snapshot), `guarantor_requests` (member, loan, status, exposure at consent time), `loan_decisions` (approval chain, versioned), `loans` (approved terms snapshot: rate, tenor, multiplier, schedule params — immutable), `repayment_schedules`, `repayments`, `allocations` (order configurable), `collection_actions`, `arrears_state` (DPD, flags).
7. **Payroll**: `payroll_batches` (period, source_hash, control_total, state), `payroll_rows`, `validation_errors`, `payroll_postings` (journal link).
8. **Payments**: `payment_intents` (org, member, purpose, amount, ref UNIQUE, idempotency), `virtual_accounts`, `provider_transactions` (provider ref UNIQUE, status, raw payload), `webhooks` (provider, event, signature status, dedupe hash UNIQUE), `reconciliation_runs`, `reconciliation_items`, `refunds`.
9. **Accounting**: `chart_of_accounts` (org, code, name, type, parent), `ledger_accounts`, `journal_entries` (org, period, date, state DRAFT/POSTED/REVERSED, source_type, source_id, memo, balanced flag), `journal_lines` (journal_id, account_id, debit, credit, member_id nullable, metadata jsonb) — **append-only once POSTED**, `accounting_periods` (state OPEN/SOFT_CLOSED/LOCKED, reopened_by/reason audit).
10. **Workflow/Governance**: `approval_policies`, `approval_requests`, `approval_steps`, `approval_actions`, `delegations`, `comments`.
11. **Documents**: `document_templates`, `generated_documents` (object key, tenant prefix), `document_versions`, `signatures_or_acceptances`.
12. **Communications**: `notification_templates`, `notifications`, `delivery_attempts`, `preferences`, `consent_records`.
13. **Audit**: `audit_logs` (actor, org, action, object, before/after jsonb, ts, ip, session) — insert-only, restricted role, `access_logs`, `incidents`, `data_export_requests`, `retention_actions`.
14. **Channels (optional)**: `ussd_sessions`, `whatsapp_sessions`, `agent_collections`.
15. **SaaS ops**: `support_access_sessions` (time-limited, audited), `billing_invoices`.

**Core financial relationship invariants**
- `journal_entries.balanced` enforced in-app in the same transaction + DB trigger asserting `SUM(debits)=SUM(credits)` per entry (guard against code bugs).
- `savings_transactions/journal_lines/journal_entries` all carry `source_id`; corrections = reversal of original + new posting (FR-036).
- `loans.approved_amount` caps disbursements (FR-022).
- Opening balances: import with signed control totals, approval, audit (PRD §11).

---

## 4. MULTI-TENANCY & RLS STRATEGY

**Layers (defense in depth)**

1. **Tenant resolution** — from authenticated identity only (JWT org claim or subdomain lookup at middleware). Never trust client-supplied `organization_id`. Requests include resolved `orgId` context.
2. **Application-level scoping** — every repository query takes `orgId` from the request context (NestJS `TenantContext`), never from the body. Cross-tenant references blocked by tenant-aware validation.
3. **PostgreSQL RLS (defense in depth)** — all tenant-owned tables have `organization_id`, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, and one policy per table:
   - `USING (organization_id = current_setting('app.tenant_id', true)::uuid)`
   - App sets `SELECT set_config('app.tenant_id', :orgId, true)` **inside the request transaction** (transaction-local, auto-reset).
   - App DB role has no `BYPASSRLS`.
4. **Connection pooling** — each request transaction begins with `SET LOCAL app.tenant_id`; pooled connections never leak tenant context between requests. Postgres `RESET` guaranteed at transaction end.
5. **Super-admin / support access** — separate role path: support sessions are time-limited (FR-048), switch tenant context with full audit trail, never same credentials as tenant users.
6. **Storage** — object keys tenant-prefixed (`orgs/{orgId}/...`), access via short-lived signed URLs only, verified against authorization.
7. **Acceptance proof** (§20 PRD) — adversarial test suite: identical member numbers across two tenants; guessed UUIDs; cross-tenant exports and references must all fail at app and RLS layers (§11 tests).

---

## 5. AUTHENTICATION & RBAC DESIGN

**Authentication**
- NestJS + Passport; `access` JWT (short-lived, 15 min) + `refresh` token (rotation, stored hashed server-side, revocable) in httpOnly cookies.
- Login rate limiting (Redis), lockout after N failures, audit on success/failure.
- **MFA (TOTP) mandatory for privileged roles** (SaaS Admin, Coop Admin, Chairman, Treasurer/Finance, Accountant, Credit Committee, Payroll Officer approver paths) — enforced by role check at login and at sensitive action time (step-up where configured). Backup codes. MFA setup flow in onboarding.
- Sessions device-tracked; privileged actions log session id; logout revokes refresh token.

**RBAC**
- `permissions` table seeded from PRD §7 permission set (`members.create`, `savings.post`, `loans.disburse`, `payroll.post`, `journals.approve`, `reports.export`, `settings.manage`, `users.manage`, `audit.view`, `payments.reconcile`, etc. — full canonical list in `packages/shared`).
- Roles assignable at: SaaS scope, org scope, optionally branch scope (multi-role allowed per PRD §7).
- NestJS `@RequirePermissions('loans.approve')` guard; frontend menu/route gating from same permission map.
- **Maker–checker rule enforced in code**: an approval step fails if `approver.user_id == initiator.user_id` (FR "no self-approve where maker-checker applies").
- Seeded role templates per PRD §7 restrictions (e.g. Auditor = read-only enforced by guard class, Field Agent restricted set).

**Approval engine**
- Generic `ApprovalRequest` state machine: PENDING → (APPROVED|REJECTED|RETURNED), ordered steps, per-step policy (role/limit), SLA, evidence, comments, delegation. Loans/payroll/withdrawals/journals register their step templates. Versioned sequential approvals per FR-020.

---

## 6. ACCOUNTING / LEDGER ARCHITECTURE

**Principles (from PRD §9, §11)**
- Every supported financial event auto-generates a **balanced, source-linked double-entry journal** (FR-034) — savings received, share capital, loan disbursement, principal repayment, interest, fees, penalties, provider settlement, write-off, corrections.
- **Append-only ledger**: posted journal rows are immutable; corrections are linked reversals (FR-036). No `UPDATE`/`DELETE` paths on posted rows (DB triggers block).
- Idempotent posting: financial write commands carry `Idempotency-Key`; unique index prevents double-posting (webhooks, retries, duplicate submissions).
- Period rules: `OPEN → SOFT_CLOSED → LOCKED`; posting blocked outside open period; reopen = privileged + audit reason (FR-037).
- Default account mappings stored per tenant chart; recognition validated with a Nigerian cooperative accountant pre-production (PRD §11).

**Posting flow**
1. Business event committed (contribution, repayment, disbursement…) with source reference.
2. Accounting module derives journal lines from tenant chart mapping.
3. In **one DB transaction**: validate period open + balances → insert journal + lines → update member/ledger balance read-models → mark source posted → emit events (receipt, notification, read-model refresh).
4. Reversal = new entry `reversal_of_journal_id`; exact inverse lines; separately approved where policy requires.

**Balance read-models**
- `member_accounts.balance` and account balances updated **in the same transaction** as the journal (consistent, auditable). Daily/monthly ledger reconciliation job re-derives balances from journal lines to detect drift (FR-032-style integrity).

---

## 7. API ARCHITECTURE

- REST/JSON under `/api/v1`, OpenAPI/Swagger auto-generated (PRD §14 endpoints as the contract baseline).
- NestJS global pipes (validation), guards (auth → tenant → permissions), interceptors (logging/correlation), filters (structured error envelope `{error: {code, message, requestId}}`).
- **Idempotency-Key** middleware: financial writes only (POST contributions, disbursements, repayments, payroll post, journal post, webhooks).
- Pagination/filtering/sorting on all list endpoints; consistent cursor/offset convention.
- Rate limiting per user/IP with Redis; per-endpoint tiers (auth endpoints strictest).
- Correlation ID end-to-end (API → logs → workers → provider calls).
- Tenant context from middleware (subdomain/JWT), never body params.
- Versioned public routes; breaking changes = new version.
- Download endpoints return signed object URLs for documents/reports/exports.

---

## 8. BACKGROUND-JOB ARCHITECTURE

- **Redis + BullMQ** (worker processes separate from API process in deployment).
- Job categories & schedules:

| Queue | Purpose | Trigger |
|---|---|---|
| notifications | Email/SMS/WhatsApp dispatch + retry + delivery log | event-driven |
| webhooks-in | provider webhook processing (dedupe, verify) | provider event |
| webhooks-out | outbound notifications to tenant endpoints (V3) | event-driven |
| reconciliation | auto-match, exception queue, post | schedule + manual |
| documents | PDF/XLSX/CSV generation (receipts, statements, agreements) | event/manual |
| imports | member CSV/XLSX + opening-balance imports | manual |
| reports | heavy report generation/export | manual |
| payroll | batch processing pipeline | manual |
| delinquency | **daily 23:59 WAT** DPD milestones/reminders/restrictions (PRD §10.6) | cron repeatable |
| retention | data-retention/cleanup jobs | cron |

- Every job idempotent; `jobId` derived from business key (e.g. webhook dedupe hash, import batch id).
- Retries with exponential backoff; DLQ + alert after N failures.
- All workers tenant-aware (queue jobs carry `orgId`, re-assert tenant context before DB work).
- Visibility: BullMQ dashboard in dev; job metrics/logs in prod.

---

## 9. PROVIDER-ADAPTER ARCHITECTURE

Single adapter interface per capability, tenant-configurable provider selection, secret keys server-side only.

| Capability | Interface | V1 adapters | Notes |
|---|---|---|---|
| Payments | `PaymentProvider` (create payment intent, virtual account mgmt, verify/query, parse webhook, reconcile) | **Monnify** (virtual accounts/inbound) + **Paystack** (collection) | Provider transaction table stores raw + normalized; webhooks signature-verified + deduped (FR-031) |
| KYC | `KycProvider` (submit verification, result webhook) | **Smile ID** (NIN/BVN) | Store verification tokens/results only — **no raw BVN/NIN retention** (PRD §18) |
| SMS/WhatsApp | `MessagingProvider` (send OTP, notification; WhatsApp template) | **Termii** | Consent + delivery log + preferences |
| Email | `EmailProvider` | SMTP/transactional (e.g. Postmark/SES) behind interface | Same notification pipeline |
| Storage | `StorageProvider` (put/get, signed URLs) | S3-compatible (MinIO local, cloud prod) | Tenant-prefixed keys |
| Documents | `DocRenderer` | Local (PDF via templates) | Receipts/statements/agreements |

**Rules**
- Provider failures never corrupt financial state: status transitions wait for server-side verification (PRD §9: client redirect alone insufficient).
- Provider credentials per tenant where required, encrypted at rest.
- Each provider has contract tests (recorded fixtures) + integration toggle in staging only.

---

## 10. FRONTEND APPLICATION ARCHITECTURE

**App 1 — Portal (SaaS Super Admin + Cooperative Admin)**
- Next.js (App Router), one app with two zones: `/saas/*` (super admin) and `/:orgSlug/*` (tenant admin, org resolved in middleware → sets tenant context header for API).
- Server Components for lists/dashboards; Client Components for workflows (wizard, approval inbox, imports); TanStack Query for server state; React Hook Form + shared Zod schemas from `packages/contracts`.
- RBAC-aware: route guards + menu filtered from the same permission map; 403 UI.
- Screen inventory implemented from PRD §13 (Executive Dashboard, Member 360, Bulk Import, Loan workbench, Payroll batches, Reconciliation, Chart of Accounts, Trial Balance, Financial Statements, Approval Inbox, Report Centre, Settings incl. Users & Roles / Approval Workflows / Finance & Numbering / Integrations…).
- NGN/WAT/African phone formats default; configurable terminology per tenant (NFR-010).

**App 2 — Member PWA**
- Installable, mobile-first, low-bandwidth friendly; screens from PRD §13 (Home, Savings & Shares, My Loans, Apply for Loan, Guarantor Requests, Payments, Documents & Notices, Profile & Security).
- Offline shell + minimal data caching; signed-URL downloads.
- Auth via same API (cookie/JWT), MFA only where role requires (members typically no MFA, step-up where configured).

**Shared**
- `packages/ui` design system (components, tokens); consistent empty/loading/error states; accessibility (NFR-012).
- Charting for dashboards/reports; export buttons wired to report endpoints.

---

## 11. TESTING STRATEGY

| Layer | Tooling | Scope |
|---|---|---|
| Unit | Jest (api), Vitest (web) | Services, permission logic, loan math (interest/schedules/allocations), workflow transitions, adapter mapping |
| Property-based | fast-check | Loan schedule correctness vs. interest methods; allocation order; no lost kobo (integer-kobo property) |
| Integration | Jest + Testcontainers (Postgres+Redis+MinIO) | Repository + RLS policies, journal balance trigger, idempotency, payroll atomicity, webhook dedupe |
| Tenant isolation (adversarial) | Integration suite | Two tenants, identical member numbers, guessed UUIDs, cross-tenant export/reference attempts — must fail at app **and** RLS layer |
| Financial integrity | Integration suite | Every FR-010/020/022/023/026/028/032 scenario leaves balanced ledger, statement matches posting, reversals exact |
| API contract | supertest + OpenAPI diff | All §14 routes; validation errors; auth failures; pagination |
| E2E | Playwright | Portal journeys (onboard coop → member → contribution → loan → payroll → report), PWA member journeys, approval chains |
| Load smoke | k6 | Login, member list, dashboard p95 targets (NFR-002) |
| Migrations | CI job | up/down on clean DB; upgrade from previous release snapshot |
| Security | npm audit/Trivy + OWASP top-10 review | Dependencies + container; manual pentest checklist pre-pilot |

- Coverage gates on the money paths (accounting, loans, payroll) mandatory; general ≥80% lines.
- Each sprint's Definition of Done includes its tests + passing CI.

---

## 12. CI/CD & ENVIRONMENT ARCHITECTURE

**Environments**
1. `dev` — per-developer or shared (Contabo VPS), docker-compose (postgres/redis/minio), auto-deploy on PR merge to `develop`.
2. `staging` — production-like; provider integrations in sandbox mode; migration rehearsal; Playwright runs.
3. `production` — pilot tenants only after acceptance criteria (§20 PRD) met; RLS/migration verified.

**CI (GitHub Actions)**
- Job chain: lint → typecheck → unit → integration (services via containers) → adversarial tenant-isolation suite → e2e → build images → security scan → publish images (GHCR).
- Branch protection: PRs only; required checks.

**CD**
- Deploy target: Contabo VPS (dev/staging) with docker-compose; same images promoted to prod; DB migrations run as a dedicated one-shot job (lock-protected, never from multiple replicas).
- Zero-downtime attempt: rolling update of API + workers; migrations forward-compatible (expand → migrate → contract).

**Operations**
- Backups: nightly `pg_dump` + continuous WAL archiving; **restore drill quarterly** (RPO/RTO documented — see §15 decision).
- Observability: structured logs (pino) shipped central; Sentry for errors; Prometheus/Grafana for metrics; Uptime Kuma/healthchecks for liveness; alerting to the operator channel.
- Runbooks in `docs/` (incident, backup/restore, onboarding a tenant).

---

## 13. SECURITY ARCHITECTURE

- Transport: TLS everywhere; HSTS. Cookies: httpOnly, secure, SameSite.
- At rest: disk encryption on VPS; DB backups encrypted; provider secret keys encrypted (KMS/age) and server-side only.
- AuthN/Z: MFA for privileged roles, session rotation, rate limiting, least-privilege RBAC, maker–checker, audited time-limited support access (FR-048).
- **PII/national identifiers**: raw BVN/NIN not retained; provider tokens/verification results + protected derived values only (PRD §18). No plain unsalted SHA-256 as safeguard.
- Audit integrity: `audit_logs` insert-only; DB role without UPDATE/DELETE on audit tables; append of security events (MFA, support access, config change, export, reversal).
- Webhooks: signature verification, dedupe, replay protection (timestamp window).
- File access: tenant-prefixed keys + signed expiring URLs; MIME/size validation on upload.
- Dependency/container scanning in CI; non-root containers; minimal image.
- Compliance: NDPA 2023 / NDPC guidance review + cooperative-law + payment regulatory review before production (PRD §18). Privacy notice, retention, data-subject request and incident-response processes documented.
- Co-opEngine never holds cooperative funds: money flows via licensed providers; platform is not custodian by default (PRD §18).

---

## 14. SPRINT-BY-SPRINT IMPLEMENTATION SEQUENCE

Assumption: small team (1–2 backend, 1 frontend, agent-assisted) or solo with agent as team. 2-week sprints. Phases map to Master Prompt Phase 0–11.

| Sprint(s) | Phase | Deliverables (exit criteria) |
|---|---|---|
| S1 | 0 | Monorepo, docker-compose, CI skeleton, env config, lint/typecheck/test pipeline green, ADR folder, repo docs |
| S2–S3 | 1 | DB migrations v1, organizations+settings+branches, auth (login/MFA/sessions), RBAC (roles/permissions/user_roles), tenant middleware + RLS enabled on identity/tenancy tables, audit_logs; API: §14 auth/org/members core |
| S4–S5 | 1+2 | Membership module complete: member lifecycle, member_no, employment, next-of-kin, KYC abstraction, documents, CSV/XLSX import with control totals; Member 360 API |
| S6–S7 | 3 | Savings: products, member_accounts, contribution single/bulk posting, withdrawals with policy+approval, statements; journal integration for savings events |
| S8–S9 | 4 | Accounting core: chart of accounts, journal engine (balanced, source-linked, idempotent), reversal, periods OPEN/SOFT_CLOSED/LOCKED, GL/trial balance endpoints |
| S10–S11 | 5 | Shares module (products, transactions, register) |
| S12–S15 | 6 | Loans: products + templates (3×, 15% cash, 12.5% asset finance), eligibility, guarantors, versioned approvals, schedules, disbursement (maker-checker), repayment + allocation, arrears DPD engine + 23:59 WAT job, restructure/payoff |
| S16–S17 | 7 | Payroll: batch upload/map, source hash + control totals, validation/exceptions, approval, atomic posting, reversal; reports for payroll |
| S18–S19 | 8 | Payments: payment intents, virtual accounts (Monnify), provider transactions, webhook ingestion (verified+deduped), reconciliation queue + auto-match + exception workflow |
| S20–S21 | 9 | Reporting + Documents + Notifications: report catalog (PRD §16), PDF/XLSX/CSV exports, document templates/generation, email/SMS/WhatsApp notification pipeline |
| S22 | 10 | Portal frontend hardening: executive dashboards, all admin screens polished, RBAC menu/route gating, approvals inbox UX |
| S23–S24 | 11 | Member PWA + channels: PWA journeys, WhatsApp flows, optional USSD/agent feature-flagged |
| S25–S26 | 12 | SaaS Admin + billing: control centre, subscriptions, invoices, plan enforcement, support access, usage limits |
| S27–S28 | 13 | Hardening: adversarial tenant tests full pass, backup/restore drill, load smoke, security review, runbooks, pilot onboarding kit |
| S29+ | — | Pilot: onboard first cooperative, opening balances, monthly cycle, fixes; then GA rollout |

**Dependencies**: loans depend on savings + accounting; payroll depends on membership + accounting; payments/reconciliation depends on accounting; PWA depends on core APIs. Frontend portal is built incrementally in parallel from S4 onward (thin slices each sprint).

---

## 15. KEY TECHNICAL DECISIONS REQUIRING PRODUCT-OWNER APPROVAL

| # | Decision | Recommended default | Impact if delayed |
|---|---|---|---|
| 1 | Payment provider order & virtual accounts mandatory? | Monnify first (virtual accounts); Paystack collection adapter; virtual accounts required for pilot | Blocks S18–S19 |
| 2 | KYC provider & BVN/NIN retention | Smile ID; store verification tokens/results only | Blocks FR-008 depth; compliance risk |
| 3 | Messaging provider (SMS/WhatsApp OTP + notifications) | Termii; WhatsApp Business number owned by operator | Blocks notifications + WhatsApp channel |
| 4 | Domain/subdomain convention + brand domain | `{slug}.app.<domain>.ng` style; reserve domain early | Cosmetic until prod; needed for cookie/tenant resolution |
| 5 | Loan policy defaults vs pilot constitution (3×, 15%, 12.5%, grace/default milestones, guarantor caps) | Validate against pilot coop bylaw before pilot config | Wrong defaults = wrong pilot config only (configurable by design) |
| 6 | Chart of accounts validation | Nigerian cooperative accountant review before production | Pre-production gate |
| 7 | USSD/agent mode in V1 or feature-flagged | Feature-flagged pilot extension | Scope only |
| 8 | RPO/RTO targets + backup cadence | RPO ≤ 15 min (WAL), RTO ≤ 4 h; restore drill quarterly | Ops definition |
| 9 | MFA policy details (which roles always MFA; step-up actions) | All privileged roles MFA; step-up for disbursement/reversal/journal post | Security posture |
| 10 | Repayment allocation order default | penalties → fees → interest → principal (configurable per product) | Default policy |
| 11 | Deploy target for production | Staged: Contabo for dev/staging; production VPS or managed PG later | Ops scale |
| 12 | Auth session model | JWT short access + rotating refresh (hashed, revocable), httpOnly cookies | Not blocking; security review item |
| 13 | Repo hosting/CI | GitHub private monorepo; GitHub Actions | Blocks Phase 0 start |
| 14 | DB access library | Drizzle ORM + `pg` (type-safe SQL, RLS-friendly raw SQL); Prisma acceptable alternative | Affects migration ergonomics |

---

## APPENDIX A — DOCUMENT DELIVERY CHECKLIST (post-approval, per iteration)
Each engineering iteration will report: Completed work, Result (test evidence), Decisions needed, Next recommended action — per the user's operating standard, and never claim completion without verified tests.

## APPENDIX B — ASSUMPTIONS LOG
- Team executes with agent-led development unless a hired team is introduced.
- Pilot cooperative access and bylaw data arrive by S12 (loan config validation) and S29 (full cycle).
- Provider sandbox accounts (Monnify/Smile ID/Termii) available by their integration sprints.
- No raw BVN/NIN retained; no custodial handling of cooperative funds.
