# REC-06 exact loan repayment amounts

Repayment capture now parses money into integer kobo and retains exact decimal strings from PostgreSQL through installment allocation, outstanding principal updates, journal lines, notification metadata and audit records. Existing due-order allocation (interest before principal within each installment), HTTP-number request/response contracts, permission checks and transaction boundaries remain in place. Audit money metadata now uses fixed two-decimal strings.

Allocation must conserve the entire received amount before journal posting. A negative remaining installment component or principal balance is rejected and the transaction rolls back. Overpayments remain rejected; duplicate keys retain the existing conflict behavior. Durable idempotency, defaulted-loan repayment policy, fees/penalties, historical reconciliation, reducing-balance products and other financial services remain separate open recovery work. This does not close REC-06.

Six additional disposable PostgreSQL API regression journeys cover 115 one-kobo payments, interest-first partial allocation and final payoff, one-kobo overpayment rejection, maximum supported numeric repayment, closed-period rollback and duplicate-key rejection. Each verifies persisted amounts, outstanding balance and journal conservation; no production database or real provider is involved.

The local updater also starts and waits for an existing PostgreSQL service before taking its backup, ensures the member and gateway services are started, and polls both loopback login pages for bounded startup readiness. This addresses the observed stopped-database and gateway-startup failures without resetting volumes or reseeding users.

Local TypeScript checks, API build, 388 API unit tests and 44-migration history checks passed. Draft-PR CI must verify PostgreSQL integration and the isolated Docker/PowerShell/browser rehearsal before handoff.

The user confirmed the preceding cumulative PR12/PR13 update is opening and working on 2026-10-04 at 17:29 Africa/Lagos, and confirmed everything working at 17:33. This is local user acceptance, not production deployment or complete product acceptance. This repayment update still requires installation after automated verification.
