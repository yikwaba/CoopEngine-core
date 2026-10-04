# Global authenticator replay protection and sensitive-action verification — REC-05

This draft batch stacks on PR #11. The user reported its previous local installer passed on 4 October 2026 at 12:49 Africa/Lagos. That report confirms local update acceptance, not production deployment or full financial acceptance.

## Behavior

An authenticator time step can succeed only once for a user/factor across enrollment, distinct login challenges, recovery-code regeneration, optional factor disabling and sensitive actions in any cooperative. A global database counter is claimed atomically under the same user lock as MFA session issuance. Enrollment/session failures roll back the claim. Password reset/revocation does not reset it. Backup recovery claims its separate single-use credential and permits replacement enrollment only; it cannot forge a TOTP proof.

Production always requires fresh verification for the reviewed sensitive-action routes. Isolated/local tenants can enable `security.requireStepUpForSensitiveMoney`. Authentication and permission guards run first; a global interceptor checks the explicit route policy before controller validation/business work. Header `X-CoopEngine-Step-Up` supplies the six-digit code; the two legacy journal/disbursement `otp` body fields remain accepted. A valid sensitive-action code is consumed even if subsequent validation or business work fails. Use the next authenticator code to retry; consuming proof does not imply the financial operation succeeded.

Failed step-up codes/replays are counted durably under the user lock: five failures per user in fifteen minutes, across sessions/routes/tenants/API instances. Further attempts return 429 until the window clears. Successful codes do not remove the failed-attempt record. No code/secret is written to audit metadata.

Missing verification returns an explicit pre-operation `403 STEP_UP_REQUIRED`. The staff portal opens a keyboard-accessible native modal and retries the original payload once, using the cookie and a fresh code. Cancellation sends no retry. Ordinary permission denials, invalid/replayed verification, rate limits, network failures and server errors never trigger automatic financial retries. Codes remain in request memory only. Invalid verification returns 403, preserving the existing session.

## Reviewed route inventory

The registered-controller test enumerates all mutations in eleven reviewed controllers. Each must have a sensitive-action policy or an explicit exemption; a new unclassified mutation fails the test. The 29 protected routes are:

- Ledger journal approve/post, reversal and period status/close/reopen.
- Loan approval, disbursement, repayment capture and restructuring.
- Savings deposits, withdrawal requests/posting, withdrawal approval, interest posting and withdrawal-approval policy changes.
- Share purchase/redemption; payroll approval/posting and reversal.
- Generic approval decisions and alternate payroll/journal approval routes.
- Dividend posting; manual payment transaction recording, reconciliation and exception assignment.
- Bulk share-purchase/loan-repayment commit; cooperative security settings; staff invitations/roles/status changes.

Unposted drafts/previews/submissions/rejections have explicit exemptions. Provider webhooks use their own signature boundary, not staff OTP. Provider provisioning/intents, member self-service, platform administration, product configuration and any missing/unimplemented opening-balance path require their separate boundary reviews. This is a reviewed inventory, not a claim that all conceivable sensitive actions are complete.

## Verification

Local: 366 API unit tests, 17 portal tests, API/portal typechecks and builds, JavaScript syntax, append-only migration history (44 migrations). Nine new PostgreSQL regressions cover separate-challenge races, login/action races, concurrent action reuse, durable failure limits, current permissions, production policy, failed-business consumption and counter preservation across reset/revocation. Existing MFA tests use an injected clock to advance real TOTP steps without changing JWT/database time or adding a production bypass.

Full GitHub PostgreSQL/isolated Docker/Chromium/PowerShell update-rehearsal results are pending and must be recorded before supplying an installation SHA. The browser uses actual fresh time steps, exercises dialog cancellation and a verified synthetic withdrawal-policy update, and performs no money movement or external provider operation.

Migration `0044_totp_replay_step_up.sql` adds only global verification state. The local installer backs up the dedicated database and updates API/portal/migrations without reseeding or changing private configuration. Production is untouched.

## Remaining boundaries

Secret-at-rest operational protection, assisted recovery when both password and backup codes are lost, member/platform/provider boundaries and production mail/pilot acceptance remain open. Verification precedes the business transaction; it does not prove financial atomicity, durable business idempotency or a complete in-flight permission-race matrix. Exact money arithmetic (REC-06), idempotency (REC-07), approvals/guarantors/payroll reversal/repayment allocation (REC-08–11) remain separate open P0 work.
