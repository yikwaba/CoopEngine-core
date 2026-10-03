# Recovery staging — REC-01

This is a private, synthetic local/VPS harness. It is not deployed staging,
production-equivalent security, or a certificate that the SaaS works.

The existing production launcher/provider files are deliberately not used.
The separate Compose project creates its own PostgreSQL volume and document
volume. Runtime uses staging_app (non-owner, NOSUPERUSER, NOBYPASSRLS).
Migrations/seeding run as staging_owner. No live Supabase database is used.
API/Next/fixture containers have an internal-only network: no external provider
access. Only Nginx joins the entry network, forwarding host loopback ports.
No provider credentials are accepted or supplied. OTP/payment responses are
explicit simulations; known defects are preserved for later recovery work.

## Host prerequisites and run

Use Docker Engine 28+ and Compose v2 on an approved separate host or workstation,
Node 20+ for preparation, and this reviewed repository branch. Docker 28+ is
required for localhost binding protection against the older same-L2 exposure
behavior documented by Docker. The stack builds inside containers.

```bash
bash scripts/staging/run.sh
```

Generated random staging credentials live only in `.staging/compose.env`
(mode 600), which is ignored by Git and excluded from Docker build context.
Never print `docker compose config`, inspect container environment into chat,
copy live configuration, reuse production credentials, or import real member
records. Preparation preserves existing credentials. Recreating volumes with
new credentials must be deliberate; do not delete volumes to solve a failure
until confirmed disposable.

Ports are loopback-only:

- staff: http://localhost:4310
- member: http://localhost:4320
- API: http://localhost:4399/api/v1

For a VPS, reach these through SSH forwarding of ports 4310, 4320 and 4399.
No DNS/public port changes are needed. A hosted public staging site requires
a separate reviewed TLS/cookie/access/egress configuration, not exposure of
this simulated HTTP harness.

`platform@recovery.invalid` is the synthetic platform account. Its password is
STAGING_LOGIN_PASSWORD from the private file; enter via secure sign-in handling.
The fixture job logs two synthetic tenant slugs/admin emails; their passwords
use the same generated staging-only login password. Never paste it in chat.
Each fixture invocation creates a fresh test pair. No existing tenant is edited.

## Verify actual startup

```bash
docker compose --project-name coopengine-recovery-staging --env-file .staging/compose.env -f staging/compose.yml ps -a
docker compose --project-name coopengine-recovery-staging --env-file .staging/compose.env -f staging/compose.yml logs fixtures
```

Require migrate and fixtures exit code 0, API healthy, staff/member reachable,
and the successful fixture baseline message. The baseline checks staff login,
two test cooperatives with equal member numbers, own-list/foreign-ID access,
non-owner/no-bypass runtime privileges, members ENABLE+FORCE RLS, no-context
reads and transaction-local tenant context. It posts no money and sends no
provider messages. These checks are not the full role/file/job/export matrix.

The manual/PR GitHub workflow performs container startup and this baseline on
a disposable runner. No secrets or production accounts are available to it.
Failed run means staging is not yet accepted. Do not mark REC-01 Verified from
static checks alone. Retain the workflow URL and commit SHA when it passes.

## Known limits / next acceptance

- The audited app's ordinary cookie fetch bugs, approval/consent gaps and other
  audit defects remain. This PR adds only an isolated harness.
- API NODE_ENV=development permits insecure local HTTP cookies and simulated
  providers. Production-mode TLS/MFA/provider integration still needs REC-05
  and a separate sandbox integration configuration before production acceptance.
- Existing local document storage is preserved; it does not satisfy REC-21.
- No Redis worker is claimed. The durable queue gap remains REC-24.
- Additional test roles/member OTP journeys, file/job/export isolation,
  real PostgreSQL financial failure/concurrency and UI regression checks remain.
- Record production frontend/API deployed build IDs separately; Git main equality
  alone cannot prove which commit the live app serves.

Stop without deleting data:

```bash
docker compose --project-name coopengine-recovery-staging --env-file .staging/compose.env -f staging/compose.yml down
```

Delete volumes only for this explicitly disposable synthetic project after
checking the project identity. Never run these commands against production.

References: Docker Compose network/service/startup documentation:
https://docs.docker.com/reference/compose-file/networks/
https://docs.docker.com/reference/compose-file/services/
https://docs.docker.com/engine/network/port-publishing/
