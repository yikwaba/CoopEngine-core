# Co-opEngine

Multi-tenant cooperative society SaaS for Nigeria — formal corporate cooperatives
and informal market/community cooperatives. Membership, savings, shares, loans,
guarantors, payroll deductions, payments, reconciliation, double-entry accounting,
approvals, documents, communications, reporting and member self-service.

- **PRD:** v2.0 (September 2026) — `docs/Co-opEngine_Technical_Implementation_Plan.md` and `docs/Co-opEngine_Decision_Log_v1.1.md`
- **Stack:** NestJS + TypeScript (API, modular monolith) · Next.js + TypeScript (portal + member PWA) · PostgreSQL + Row-Level Security (Supabase in prod) · Redis + BullMQ · S3-compatible storage
- **Status:** Phase 0 — foundation scaffold (Sprint 1 in progress)

## Repository layout

```
apps/
  api/          NestJS backend (modular monolith)
  portal/       SaaS Super Admin + Cooperative Admin (Next.js — placeholder)
  member-pwa/   Member self-service PWA (placeholder)
packages/
  shared/       domain constants, types, enums
  db/           Drizzle schema, migrations, seed tooling
docs/           implementation plan, decision log, ADRs
```

## Prerequisites

- Node.js ≥ 20 (v22 recommended), pnpm 9
- Docker (for local Postgres/Redis/MinIO)

## Getting started

```bash
# 1. Local infrastructure
docker compose up -d

# 2. Install workspace dependencies
pnpm install

# 3. Generate + run migrations (against local Postgres)
cp .env.example .env
pnpm db:generate
pnpm db:migrate

# 4. Build, typecheck, test
pnpm build
pnpm typecheck
pnpm test

# 5. Run the API
pnpm --filter @coopengine/api dev   # http://localhost:3000/api/v1/health
```

## Docs

- Technical Implementation Plan: `docs/Co-opEngine_Technical_Implementation_Plan.md`
- Approved Decision Log v1.1: `docs/Co-opEngine_Decision_Log_v1.1.md`
- Architecture Decision Records: `docs/adr/`
