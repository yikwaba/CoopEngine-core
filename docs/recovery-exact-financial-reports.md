# Exact financial reports and exports

Report calculations and savings reconciliation use integer kobo parsed from SQL
NUMERIC strings, including sums exceeding an individual NUMERIC(19,2) column.
Report JSON retains numeric compatibility fields and adds canonical `*Decimal`
string counterparts for money. Numeric fields can approximate huge amounts;
exact consumers should use the decimal fields. Counts, rates, date grouping and
chart geometry remain numeric.

Coverage: member 360, savings and loan books, savings reconciliation,
contributions, loan aging, exits, interest preview, consolidated statements,
board summaries, portfolio analytics, arrears and platform overview totals.
The dashboard, member details, front desk, analytics, Today strip and platform
console display exact report amounts. Other write workflows and member-space
views are outside this report slice.

All monetary CSV exports use exact decimal fields, retaining headers and column
order. CSV text preserves digits; importing CSV as numeric cells in spreadsheet
software can lose them. The Excel board workbook writes money as exact decimal
text and labels this choice. Counts remain numbers. An Excel download button is
available on Analytics. Existing workbook worksheet names/columns remain.
Its trial-balance query now excludes non-POSTED entries: the old LEFT JOIN
summed draft lines despite attaching only POSTED entry records. Board JSON
ledger net also uses POSTED entries. Trial balance remains all-time; the period
label does not redefine every board-pack metric as a monthly-only measure.

PDF money formatting and opening/paid sums preserve exact decimals. PDFs use NGN
because the built-in Helvetica font lacks the naira glyph. Tables size currency
text to fit and measure row height; columns have padding. The footer stays
inside the page margin and creates no extra page. Four actual sample PDFs were
rendered and visually inspected (member statement, loan statement, board pack,
receipt). Source NUMERIC data with more than two monetary decimal places fails
closed; no historical value is silently rounded or rewritten.

Tests cover huge values, one-kobo mismatches hidden by Number conversion,
negative statements, zero/empty totals, aggregate overflow of per-column range,
exact CSV/XLSX/PDF content, posted-only spreadsheets, tenant isolation and read
operations leaving financial tables unchanged. Synthetic projection fixtures
explicitly seed boundary values; this is precision verification, not historical
reconciliation or approval of production opening balances.

No migrations, receipt fingerprint changes, production merge or deployment.
Full accounting semantics, reconciliation across multiple savings products,
date-range statement closing balance policy, paid/partial PDF status policy and
independent accounting/financial acceptance remain open. Existing SQL report
population, accounting/reversal and interest rounding policies are preserved
except the explicit POSTED-only board ledger correction above.
