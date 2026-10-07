# Exact dividend allocation and annual retry receipts

Stacked on PR #25 (local cumulative update reported passed 7 October 2026 at 09:04 Africa/Lagos). Production is unchanged. This source-based slice is not whole-product financial acceptance.

## Contract and rounding

POST /dividends/post requires an explicit four-character year and a positive JSON-number amount with at most two decimal places, bounded by the existing supported financial input limit of NGN 100 billion. Preview retains the current UTC year default. First posts and identical retries retain HTTP 201 and the original runId/year/total/members/entryNo response. The organization/year receipt binds the actor and exact normalized amount; changed actor or amount conflicts. Current session/grants, scope, subscription and sensitive-action policy checks precede replay.

Both preview and post use integer kobo and exact stored decimal share weights. Preserve the existing non-negative half-up per-holder allocation, with drift absorbed by the largest share holder and member-number order breaking ties. Zero allocations remain skipped. If that adjustment would become negative (for example five kobo across nine equal holders), refuse the entire distribution in preview/post. No alternate rounding policy is silently introduced; approving another allocation method remains a product/accounting decision. All accepted allocations are nonnegative and conserve the exact distributable amount. Numeric HTTP display/report fields retain the existing precision limitations for extremely large stored values.

## Transaction and concurrency

The existing unique financial_write_receipts organization/action/key constraint supplies the atomic annual claim under action dividends.post and key dividend-year:YYYY. Claims serialize before the old-run precheck; the original response commits with journal, run, allocations, savings balances/movements, counters, audit and notifications. Lost responses replay without recalculating, including after share changes or period closure. Historical runs without receipts and incomplete receipts fail closed; no receipt reconstruction or history rewrite.

Lock eligible members by UUID with FOR NO KEY UPDATE, then their share accounts, then all existing savings targets by account UUID before the organization counter. Locked share snapshots define allocation; existing earliest ACTIVE savings account selection and default-product creation remain. Ordinary savings account opening now takes the same member lock, preventing duplicate account creation with a dividend. The member lock remains compatible with foreign-key key-share locks. Tested deposits and distinct-year distributions retain exact locked balances. Eligibility/new-holder changes after capture belong to a later snapshot. No new migration; all 45 recorded checksums unchanged. This does not add a dividend_runs uniqueness constraint over potentially duplicate historical years; arbitrary direct SQL and older deployed writers are outside this application receipt guarantee.

## Staff journey and recovery

New /dividends screen and dashboard navigation provide year/amount input, share-based preview, confirmation, posting result and run register with busy/error/empty states. Editing inputs invalidates the preview. Posting binds the year and amount shown by that preview; allocations are recomputed on locked shares at posting, which the page/confirmation explicitly explain. Current backend authorization remains authoritative. This is not constitutional approval administration or a dividend reversal workflow.

The shared financial transport retains the original year/amount and server-verified scope across tabs and browser restart. Overlapping tabs send nothing; uncertain responses retain recovery records. Recovery descriptions identify year and amount. Other browser profiles/devices and cleared browser data remain outside browser recovery.

## Verification and remaining gates

Local API and portal typechecks, unit/browser transport tests, script syntax, migration-history and diff checks run before publication. New real PostgreSQL cases cover identical/concurrent/changed-amount requests, replay after state change, current actor/grant/scope checks, strict input, first refusal retry, receipt-finalization fault rollback including new accounts and notifications, historical/incomplete refusal, tenant isolation, deposit concurrency, distinct years, account creation, exact large balances, overflow and unsafe rounding refusal. Disposable Chromium tests the actual screen, two-tab refusal, committed response loss, full profile restart, original year/amount replay, observer acknowledgement, one credit/run/journal and a mobile form viewport.

Full final-head CI/staging and user-local cumulative installer acceptance are recorded separately in the recovery backlog after results exist. REC-06/07 remain In progress. Payroll upload/submission and loan/journal creation identity, guarantor/sequential approval policy, historical reconciliation, independent financial/provider acceptance and production rollout remain open.
