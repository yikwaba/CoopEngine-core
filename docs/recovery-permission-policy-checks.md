# Permission policy recovery checks

REC-04 continuation; final PRD FR-005 (RBAC), FR-002 (tenant boundary); audit F01 regression prevention. This slice does not close all of REC-04.

## Result

The registered Nest module graph contains 194 HTTP routes. The automated inventory follows registered modules and controller metadata, including controllers defined in module files. Every declared permission currently has both JwtAuthGuard and PermissionsGuard, in that order. Each permission policy rejects empty/unrelated permission sets and admits each declared alternative according to the existing OR policy. No additional missing-guard defect was found after the product fix.

PermissionsGuard now rejects missing or empty permission metadata with 403, instead of silently granting access. Public and session-only endpoints continue to use their existing boundaries without PermissionsGuard.

A new registered-route regression suite fails if a declared permission loses either guard, if guards are ordered incorrectly, if a guard has no policy, or if an unreviewed route has neither a staff permission policy nor a member guard. Public/authentication, session management, signed webhook and internal-machine exceptions are enumerated explicitly; stale exceptions also fail. Member routes must retain MemberJwtGuard and the member path.

Both internal job HTTP endpoints are tested with missing, incorrect and unconfigured machine tokens: they return 401 before any tenant scan or job service call. A configured token retains successful execution. These use real controllers and mocked database/job dependencies. Existing payment integration checks exercise webhook signature rejection and valid posting.

## Verification

- Local API suite: 260 tests passed across five files, including 197 route/policy checks and eight internal-job HTTP checks.
- API typecheck and build passed; git diff check passed.
- Negative control: temporarily removed PermissionsGuard from SettingsController. Both settings route checks failed; the source was restored.
- Full repository and real PostgreSQL CI is required on the draft PR before staging installation.

## Limits and remaining work

Metadata checks prove declared boundary wiring and guard behavior, not correct business permission design, actual role provisioning, tenant scoping within every service, RLS across all tables, file ownership, member own-data scope, or durable-job isolation. The existing product real-PostgreSQL test proves that slice only. Remaining REC-04 acceptance remains open. REC-03 account recovery and REC-05 MFA/production provider guards also remain open.

The original backlog's separate-VPS staging assumption was superseded by the user's explicit local Docker staging choice. Product fix was reported installed locally on 4 October; it passed automated real-PostgreSQL permission tests before installation. No production deployment or PR merge has been performed.
