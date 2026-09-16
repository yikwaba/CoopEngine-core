# SaaS administration console

The platform operator's own surface: the cooperatives on the platform, the plans they are sold,
and what a plan actually enforces. Before this, onboarding a cooperative meant calling the API by
hand, and `organization_settings` was written once and never read — a cooperative belonged to a
plan that did not exist.

## Endpoints

All of them are SaaS-scope: they require a platform administrator (permissions `saas.*`), and a
cooperative's own staff token is refused. Cross-cooperative reads run under the narrow
`internal_scan` select policy — the same one the nightly sweeps use — never by widening a tenant
policy.

| Endpoint | Permission | What it does |
|---|---|---|
| `GET /admin/overview` | `saas.platform.health` | Cooperatives (total/active/suspended/pending), members, savings, loans outstanding, subscription counts |
| `GET /admin/tenants?q=&limit=&offset=` | `saas.tenants.manage` | Every cooperative with live numbers: members, savings, active loans, outstanding, staff, plan |
| `GET /admin/tenants/:id` | `saas.tenants.manage` | One cooperative: the above plus its settings and subscription |
| `PATCH /admin/tenants/:id` | `saas.tenants.manage` | `status` (`ACTIVE` / `SUSPENDED` / `PENDING`) and `legalName` |
| `GET /admin/tenants/:id/subscription` | `saas.billing.manage` | Subscription history for that cooperative |
| `POST /admin/tenants/:id/subscription` | `saas.billing.manage` | Assign or change the plan (`planCode` or `planId`, `status`, `renewsAt`, `notes`) |
| `GET /admin/plans` | `saas.plans.manage` | The catalogue, with how many cooperatives sit on each plan |
| `POST /admin/plans` | `saas.plans.manage` | Create a plan |
| `PATCH /admin/plans/:id` | `saas.plans.manage` | Edit a plan's name, price, limits or features |

## What a plan enforces

A plan carries `limits` (`maxMembers`, `maxBranches`, `maxUsers`; absent = unlimited) and
`features` (a name set to `false` is not included; absent means allowed).

| Boundary | Behaviour |
|---|---|
| Adding a member (`POST /members`) | `409` with the plan name, the limit and the current count when the cooperative is full |
| Bulk member import (`POST /members/import/commit`) | Checked against the **whole batch**, so an import cannot walk past the limit one row at a time |
| Payroll (`POST /payroll/import/commit`) | `403` when the plan does not include `payroll` |
| Dividends (`POST /dividends/post`) | `403` when the plan does not include `dividends` |
| Suspending a cooperative (`PATCH /admin/tenants/:id`) | Sign-in for that cooperative is refused immediately with a clear message; nothing in its data is touched |

**A cooperative with no subscription is unmetered.** The platform does not invent limits for
cooperatives that were never sold a plan, and cooperatives that existed before plans did are not
constrained by this arriving later — the demo tenant included.

## The plan catalogue

Three plans are seeded as **examples, not commercial terms** — edit them in the console:

| Code | Members | Branches | Users | Payroll | Dividends |
|---|---|---|---|---|---|
| `STARTER` | 250 | 1 | 5 | — | ✓ |
| `GROWTH` | 2,000 | 5 | 25 | ✓ | ✓ |
| `ENTERPRISE` | unlimited | unlimited | unlimited | ✓ | ✓ |

## Housekeeping

Every integration spec onboards cooperatives with generated slugs. It deletes its *users* but not
its cooperatives, so a development database accumulates them — 591 had piled up before this was
noticed, and the console faithfully listed all of them.

```bash
scripts/clean-test-tenants.sh            # dry run: what would go, and what would stay
scripts/clean-test-tenants.sh --apply    # delete them
```

A cooperative is removed only when **every** user attached to it is a test account, or when it has
no users left at all; one real user keeps it. `sunrise` is protected, and the script refuses to run
against a hosted database. `scripts/verify-all.sh` runs it after the suite, so the development
database stays honest.
