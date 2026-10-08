# Dated savings and partial-payment loan statements

A savings PDF now closes at its last displayed transaction instead of today's
account projection. An empty dated period uses the latest transaction at or
before its end; a period before all activity derives the opening balance from
the earliest transaction. Opening and closing are equal for empty periods.
Amounts use exact integer kobo, including balances above Number precision.
An account with no transaction history explicitly labels historical balances
unavailable and separately shows its current projected balance.

The loan PDF labels an instalment PAID only when both principal and interest
are fully covered. Partial future instalments show PARTIAL; unpaid or partly
paid past-due instalments remain OVERDUE. Unpaid future instalments show PENDING.
Excess principal does not conceal unpaid interest. This changes document labels,
not repayment allocation or stored loan statuses.

Regression checks render real PDFs and capture their text, exercise boundary
queries against PostgreSQL without financial writes, and download dated PDFs
from disposable Docker staging for pdftotext assertions. Synthetic test dates
are scoped to isolated fixture accounts; no production data is rewritten.

Scope remains the existing first savings account selected by the PDF endpoint;
this is not a consolidated multi-product statement or product reconciliation
fix. Historical results depend on recorded running balances; independent
reconciliation of those records remains required. Timestamps and transaction
IDs provide deterministic ordering, not a repair of historical ordering errors.
No migration, receipt fingerprint change, production merge or deployment.
