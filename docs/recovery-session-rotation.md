# Atomic session rotation — REC-03 / FR-004

## Defect and repair

Refresh previously selected an active session, revoked it and inserted its replacement through separate statements/connections. Two requests could both pass the read and create replacements. A reset could also finish revocation before a concurrent refresh inserted its new session.

Refresh now runs through one transaction/connection: identify the token owner, lock that active global user, conditionally consume the unrevoked/unexpired token and issue its replacement before commit. Password reset locks the same user before revoking sessions, so either refresh commits first (and reset revokes its replacement) or reset commits first (and refresh is denied). Replacement insertion/signing failure rolls back consumption; rejected replay creates no session.

Tenant membership, organization status and MFA policy are reevaluated with the same connection and transaction-local tenant context. This avoids nested transactions and connection-pool starvation when concurrent requests wait for the same user lock. Tenant context is restored after successful reads and rolled back on failure. A deleted/missing organization cannot silently select platform context.

JWT guards also reject database-expired sessions and inactive global users even if the JWT signature/expiry is still valid. Token responses report the configured access TTL rather than a hardcoded 900 seconds. No migration, role changes or financial writes are included.

## Verification

New real-PostgreSQL checks cover twelve concurrent refresh calls (one replacement), old-token replay, bearer/cookie logout, database session expiry, inactive users, removed membership, replacement-insert failure/rollback, concurrent tenant contexts password reset racing refresh, and retained MFA rejection audit after rollback. Full CI is required before staging installation. Existing authentication, cookie and password-reset regression suites must remain passing.

## Recorded local acceptance

On 4 October at approximately 09:50 Africa/Lagos, the user confirmed PR #7's synthetic tenant B recovery: new password signs in, old password is rejected and submitting the same link again returns 'Reset link is invalid or expired'. Those three UI checks passed. Production SMTP, expiry timing, logout/refresh concurrency and the broader REC-03 acceptance remain separate evidence gates.

## Limits

This slice closes atomic refresh consumption and the reset-versus-refresh race, not every authentication lifecycle issue. A login already verified before reset, pending MFA challenges, and logout racing a refresh require further lifecycle/version/family review. Existing JWT permission claims can remain valid until expiry after role removal; refresh reevaluates roles, while immediate permission revocation remains REC-04 work. This change does not establish production acceptance or privileged MFA enrollment/recovery.
