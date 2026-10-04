# Recovery status — 4 October 2026

Use evidence per slice. Draft PR, passing CI, user-reported local acceptance and production acceptance are distinct states. No recovery PR has been merged/deployed to production in this session.

| Recovery slice | Evidence/state | Remaining acceptance |
| --- | --- | --- |
| Isolated staging baseline (REC-01) | PR #3; dedicated local Docker database, non-owner runtime and synthetic tenant isolation checks | Broader role/file/job/export matrix and production-like provider integration |
| Cookie sessions and member/report endpoints | PR #4; user reported Members, reports/downloads, audit and other exercised local screens working | Complete financial/pilot acceptance |
| Product permission defect | PR #5; permission repair with regression checks; user local acceptance | Broader REC-04 scope |
| Registered route permission policies | PR #6; automated policy inventory/denial checks | Tenant/branch/file/job/export isolation |
| Staff password recovery | PR #7; user confirmed new password login, old password denial and reset-link replay denial | Production mail delivery, MFA recovery/bootstrap and full lifecycle matrix |
| Atomic refresh and reset race | PR #8; CI #117 passed 138 API integration tests; user reported installation/logout working | Historical refresh families, member sessions and MFA lifecycle limits |
| Production configuration guard | PR #9; CI #118 passed 338 unit/138 API integration tests; no production deployment | Combined local installation, actual OTP/payment delivery and existing simulated data review |
| Current permission resolution and remaining staff session races | This branch; implementation and ten new PostgreSQL tests; CI/local installation are required gates | Broader REC-03/04 limits recorded in recovery-session-authority.md |

## Next P0 recovery priorities

1. MFA enrollment bootstrap/recovery and replay/step-up boundaries (remaining REC-05).
2. Exact money representation and arithmetic (REC-06); prove monetary conservation and rounding before financial acceptance.
3. Durable request/webhook idempotency (REC-07), including concurrent/retry failures.
4. Approval execution, guarantor consent/eligibility, payroll reversal and default repayment allocation (REC-08 through REC-11).

These financial priorities remain open. Earlier UI success is not evidence that money movement, reversals, approvals or tenant-wide isolation are correct. Continue in reviewable batches; provide one local installer and only request manual actions that automated checks cannot establish. Private credentials and production rollout decisions remain with the user.
