# ADR-0001: Monorepo with pnpm workspaces + Turborepo

- Status: Accepted (Decision Log v1.1)
- Date: September 2026

## Context
Co-opEngine ships three applications (NestJS API, Next.js portal, member PWA) plus
shared domain code (types/constants, DB schema, validation contracts). Teams must
share code without drift and run a single CI pipeline.

## Decision
One GitHub monorepo (`yikwaba/CoopEngine-core`) using pnpm workspaces and
Turborepo task orchestration. Package scopes: `@coopengine/*`.

## Consequences
- Shared code (`packages/shared`, `packages/db`, later `packages/contracts`, `packages/ui`) versioned together with apps.
- Turbo caching keeps CI fast; `dependsOn: ^build` enforces build order.
- Requires discipline: package boundaries respected; no cross-app runtime imports outside workspace deps.

---

# ADR-0002: NestJS modular monolith

- Status: Accepted
- Date: September 2026

## Context
PRD scope is large but one deployable; team is small (agent-assisted). A microservice
split now would add operational cost without benefit.

## Decision
One NestJS application organized into strict domain modules (tenancy, identity,
membership, savings, shares, loans, payroll, payments, accounting, approvals,
documents, notifications, reporting, channels, audit, saas-admin, providers).
Modules own their tables; cross-module effects flow through services and internal
events. Future extraction to services remains possible at module boundaries.

## Consequences
- Single deployable + worker processes; simpler ops.
- Enforces repository discipline and event design to avoid module coupling.
- BullMQ workers run the same codebase for background work.

---

# ADR-0003: Drizzle ORM on PostgreSQL with RLS

- Status: Accepted (Decision Log v1.1)
- Date: September 2026

## Context
Financial multi-tenant app requires precise SQL control (RLS policies, triggers,
CTEs, numeric money), type-safe migrations and tenant isolation (PRD §9, §18).

## Decision
Drizzle ORM + `pg` on PostgreSQL. RLS enabled on all tenant-owned tables with
transaction-local `app.tenant_id` GUC as defense in depth (§4 of the plan).
Production database on Supabase (managed Postgres + PITR + Storage).

## Consequences
- Migrations are plain SQL, reviewable, and generated from typed schema.
- RLS policies live in migrations; adversarial isolation tests guard them.
- Supabase Auth is NOT used for tenant sessions — custom NestJS auth/RBAC provides
  org-scoped multi-role + maker-checker semantics.

---

# ADR-0004: Money is NUMERIC(19,2), never float

- Status: Accepted
- Date: September 2026

## Context
Financial integrity is a core KPI (PRD §4). IEEE-754 floats corrupt money.

## Decision
All monetary columns are PostgreSQL `NUMERIC(19,2)`; application code performs
kobo-safe integer arithmetic where multiplication/division occurs (e.g. interest
schedules) and converts at boundaries. Property tests guard loan math.

## Consequences
- No float columns; serialization keeps decimal strings; formatting at UI boundary.
