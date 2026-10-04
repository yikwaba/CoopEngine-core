# Exact loan money — first REC-06 slice

This draft stacks on PR #12. Its local Windows acceptance remains unconfirmed; a cumulative installer includes both batches. No production deployment is authorized or performed.

## Problem and behavior

Binary floating-point multiplication can distribute principal incorrectly: `1.15 * 100` is slightly below 115; the previous five-month split produced four 22-kobo installments and a 27-kobo final one. Integer kobo now produces five exact 23-kobo installments.

This slice repairs the loan application principal, savings/multiplier eligibility ceiling, flat-interest schedules for disbursement and restructuring, disbursement journal amount and opening outstanding principal. Database money/rate strings remain strings through arithmetic and persistence. No new package dependency or database migration is needed.

- Money is parsed into `bigint` kobo, with exact NUMERIC(19,2) range checks. Ambiguous strings and more than two decimal places are rejected rather than silently rounded.
- Existing JSON-number loan clients remain compatible within ₦100 billion per application, matching the other financial endpoint input bounds. Larger numbers are rejected before writing; large existing database decimal strings remain exact internally. Changing the full API/UI money serialization is still open.
- Product rates retain all four stored decimal places; multipliers retain two. Flat interest is `principal × annual percentage × months / 1200`, rounded once to the nearest kobo with positive half-up ties (PostgreSQL `numeric round`). This preserves the existing positive rounding intent; no fee, compounding, eligibility or constitution policy was invented.
- Principal and total interest are each split by integer division. Only the final installment receives the remainder, so every kobo is conserved for terms 1–60. Overflow is rejected before schedule persistence and the existing disbursement transaction rolls back journals/status/counters.
- Applied rate/method snapshots stay authoritative after product changes. Existing schedules/balances are not rewritten by installation. An explicit restructuring request uses the same exact split for its new schedule; restructuring eligibility/history/interest policy is not declared fully accepted.

## Verification and installation

Twenty-two calculation regressions cover the 23-kobo defect, cash/asset/fractional rates, half-kobo rounding, every supported tenor, large decimal strings, strict input and overflow. Twelve new PostgreSQL cases exercise actual API application/approval/disbursement, savings limits, exact stored schedule/journal/outstanding totals against an independent PostgreSQL numeric oracle, rate snapshots and failed-disbursement rollback. Full check evidence and exact tested head are recorded in draft PR #13 before handoff.

The cumulative PowerShell installer backs up the existing isolated database and updates API/portal/migrations without reseeding. It additionally checks 80 compiled loan calculations against PostgreSQL inside a read-only transaction, with no member-money mutation or provider call. The isolated workflow rehearses the installer and retains the existing real Chromium MFA/step-up checks.

## Still open

REC-06 is In progress, not Verified. Loan repayments/allocation, savings/shares/payroll/payments/dividends/bulk and manual-ledger calculations still contain floating-point paths. Legacy monetary JSON response/display conversions, reducing-balance interest, date/month-end schedule semantics, fee/penalty policy, product eligibility limits and independent financial acceptance remain open. Existing-data discrepancies require review; this batch performs no historical repair. Request/webhook idempotency, approval races and defaulted repayment remain separate REC-07–11 work.
