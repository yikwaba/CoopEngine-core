# Current permissions and session revocation — REC-03 / REC-04

Staff requests previously trusted permission snapshots in JWTs. Removing a grant, replacing a role or removing tenant membership left old access tokens effective until expiry. JwtAuthGuard now resolves current grants from the persisted session's tenant/platform context on every request, verifies JWT user/context match the session, and denies missing current membership. Role grants from other tenants/scopes cannot supply permissions. Auth/me returns current permissions; token snapshots remain for response compatibility only. This adds role joins to the existing per-request session lookup; production load/performance acceptance remains separate.

Credential verification now carries an internal authentication version. Session issuance locks the active global user, checks that version and second-factor state, and inserts/signs tokens in the same transaction. Reset increments the version while locking the same user and revoking existing sessions. A login verified before reset cannot issue afterward; pending MFA challenges include the version and are invalidated. MFA enrollment is preserved. Existing pre-update MFA challenges without a version intentionally require fresh sign-in.

Every initial login starts an independent refresh family. Rotation inherits that family. Logout locks the same user as refresh/reset and revokes the entire family, preserving independent device logins. Its dedicated guard accepts a signed, unexpired predecessor even after rotation or membership removal solely for logout. Ordinary routes still deny revoked predecessors. Registered-route checks enforce that this guard is used only on logout. Already-expired JWTs cannot use this special boundary.

## Migration and local installation

0042_session_authority.sql adds users.auth_version, sessions.family_id and a user/family index. Existing sessions receive distinct family IDs; already-rotated historical chains cannot be reconstructed and are not retroactively linked. No money/provider/tenant records are modified. Apply before running the new API. PostgreSQL may lock users/sessions briefly during DDL; schedule any future production rollout after separate review. This branch is not deployed to production.

scripts/staging/install-recovery.ps1 installs into an existing isolated Windows recovery project. It preserves private configuration, builds the API image, creates/checks/copies a local pg_dump archive, stops the API, applies append-only migrations without reseeding passwords/RBAC, starts the API with a health wait, restarts the gateway and runs automatic checks. Failure stops the script; it never deletes volumes or performs automatic rollback. Retain the backup. The API may remain stopped if migration fails; diagnose and rerun after correction.

scripts/staging/recovery-smoke.mjs runs only with the isolated Compose marker/database/API. It reads an existing synthetic tenant A account and uses the private generated staging password, checks platform/staff sign-in, cookie member list/detail, products, refresh/replay, predecessor logout and independent login, then cleans up its sessions. It writes only sessions/login audit records and contacts no live providers. If tenant A's generated password was changed, the smoke check must be adapted privately; do not paste credentials. The installer checks staff/member login HTML availability, not interactive browser clicks.

## Verification gates

Ten new real-PostgreSQL tests cover grant removal/addition, role replacement through bearer/cookie requests, removed membership with another tenant's grants, session/JWT context mismatch, stale pre-reset login proof, pending MFA challenge reset/preserved enrollment, newly enabled MFA between password check and issuance, family logout across two rotations, concurrent logout/refresh, and logout after membership removal. Existing session/password/MFA/tenant/financial suites remain required. Windows installer syntax and Docker smoke run in isolated-staging CI; actual Windows installation remains a distinct acceptance gate.

## Limits

This does not make an already-authorized in-flight business operation atomic with a later role change; checks apply at authentication time. Branch-level data scope, MFA enrollment bootstrap/recovery, single-use MFA challenges/TOTP replay limits, step-up policy coverage, member-session revocation, provider delivery and financial recovery cards remain open. No full REC-03/REC-04/REC-05 closure or production readiness is claimed.
