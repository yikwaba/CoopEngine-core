# Privileged MFA enrollment and recovery — REC-05 slice

This branch stacks on draft PR #10 (`recovery/session-authority`). It is not a production deployment or completion of the entire recovery backlog.

## Rules and user journey

- Production privileged roles and custom roles with administrative/write/approval/posting permissions require MFA regardless of the optional cooperative flag. Local/test accounts follow the cooperative flag; isolated recovery users are not silently locked out.
- Correct password plus a missing required authenticator returns a ten-minute opaque enrollment credential and candidate setup key, **not** an ordinary access/refresh session. The portal supports manual-key setup without a third-party QR service. A multi-cooperative user must select a current membership before enrollment/session issuance commits.
- Enabled accounts receive a five-minute login challenge. A challenge is single-use, purpose-bound, password/authenticator-epoch-bound, capped at five code attempts and limited to five new challenges per user per fifteen minutes across API instances.
- Enrollment atomically consumes its challenge, enables the candidate factor, changes the authentication epoch, revokes previous sessions, hashes ten random 128-bit recovery codes and issues a new MFA-verified session. Invalid organization selection rolls back this entire change.
- Recovery requires password first (a current login challenge) and an unused backup code. It revokes existing sessions and old factor/codes, then grants replacement enrollment only. An ordinary session is issued only after the new authenticator is verified. No email-only or administrator bypass was added.
- Enabled authenticators cannot be overwritten by `/auth/mfa/setup`. Recovery-code regeneration requires current password and factor. Optional MFA disabling revokes sessions and clears browser cookies; required MFA cannot be disabled.
- Existing sessions migrate with `mfa_verified=false`: a required privileged context demands fresh verified sign-in, including after refresh or a role/policy escalation. Refresh preserves MFA proof; it cannot upgrade a password-only session.
- Setup keys, challenges and backup codes are kept out of browser storage, URLs and audit metadata. Sensitive successful responses use `Cache-Control: no-store`. The portal shows/downloads backup codes once; subsequent sets replace older codes.

## Verification gates

Verification gates: API unit tests, portal tests, API/portal typechecks and builds, JavaScript syntax and append-only migration history (43 migrations). The PostgreSQL suite adds thirteen enrollment/recovery/race regressions, including concurrent challenge and backup-code submissions, expiration, purpose mismatch, reset invalidation, multiple cooperative selection and custom withdrawal-only role escalation. Current evidence is recorded in draft PR #11's checks and description.

The isolated-staging workflow installs ephemeral pinned browser tooling and runs `scripts/staging/mfa-browser.mjs` against the real API/portal after rehearsing the PowerShell installer. It creates only a new synthetic cooperative/account, confines browser requests to the two loopback origins, exercises the cookie dashboard, backup-code download/regeneration, normal MFA sign-in and replacement enrollment, and retains no traces/screenshots containing secrets. It performs no monetary posting or external-provider action.

CI results must be recorded before supplying an installation SHA. A passing local build is not a passing PostgreSQL/browser test or user installation. The custom-role rule exempts only explicitly read-only `.view`/`.lookup` grants; other and future permissions are privileged by default.

## Installation and boundaries

Migration `0043_mfa_enrollment_recovery.sql` adds global identity challenge/recovery tables and persisted session MFA proof. The installer backs up the dedicated isolated database, applies migrations **without reseeding**, updates both API and staff portal, restarts them and runs existing recovery smoke checks. It preserves private configuration, volumes and existing passwords; the unchanged member container retains its installed image. Production is untouched.

Remaining REC-05 work includes global per-time-step TOTP replay rejection across different challenges and money step-up operations, full step-up route coverage, lost-password-and-lost-backup-code assisted recovery policy, secure secret-at-rest operational verification and production mail/provider/pilot acceptance. Challenge/backup-code single-use is **not** a claim that one authenticator code cannot be reused across separate challenges during its valid time step. Legacy `/mfa/verify-setup` remains HTTP 204 and revokes old sessions; those clients must sign in again and use regeneration to obtain backup codes. The current portal uses `/mfa/enroll` instead.

Exact money arithmetic, request/webhook idempotency, approval execution, guarantor consent, payroll reversal and repayment allocation remain separate open P0 priorities.
