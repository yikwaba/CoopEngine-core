# Savings contribution minimums

Configured `min_deposit` applies to the exact amount credited in a posting. Manual deposits check the selected product; payroll and provider savings allocations select REGULAR-SAVINGS explicitly. Payroll retains existing per-member stored-row aggregation; normal CSV import rejects duplicate members.

Active member, account and product checks precede money writes. Manual posting and withdrawals acquire the member lifecycle lock before the account lock, matching payroll/provider order. Failed manual deposits and payroll approval roll back their receipts and financial writes. Committed retry receipts preserve the original outcome after a later rule change.

Incoming provider cash below the minimum remains in a balanced suspense journal, without a member credit. Duplicate callbacks replay the parked outcome. Explicit assignment rechecks the current rules and allocates once. Existing exception assignment does not update payment-intent progress; that linkage remains separate recovery work.

Products exposes exact decimal minimums and permits editing through the existing product update endpoint. The numeric transport is retained; edits that cannot round-trip exactly are refused before sending. Opening an account displays its product minimum but does not require an opening deposit.

## Acceptance

Use isolated local staging. Set the product minimum to 1.15 in Products, then blur the field to save. A staff deposit of 1.14 must fail without a balance change; 1.15 must post once. Verify the member sees the exact resulting balance. Restore the intended product minimum after this synthetic test.

Automated coverage includes database rollback, policy changes, active-state checks, retry/concurrency, explicit regular-account selection and member/account lock ordering. The staging browser flow exercises the actual editor, account/deposit controls, payroll/provider APIs and member OTP display.

No retained-minimum balance, maximum contribution, reservation, collateral or notice-period policy is introduced. Interest/dividend credits retain their existing rules. Historical reconciliation and independent financial acceptance remain open. This change targets staging; production deployment is outside this recovery step.
