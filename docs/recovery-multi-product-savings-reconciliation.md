# Multi-product savings reconciliation

The old report compared every product account against the member's whole 2000
savings liability balance. Two valid accounts could therefore both be reported
as mismatches. The new report attributes liability without spreading a member
balance across products:

- A journal naming a savings account supplies that account's liability amount.
  Linked movements must agree with its amount and account/member identity.
- Shared journals (interest, payroll, dividends, provider allocation) use their
  per-account savings movements only when the entry/member total agrees exactly
  with the corresponding savings liability. This is validated subledger
  attribution, not an independent product dimension on each journal line.
- A member-only legacy journal can be attributed to the member's sole account.
  With multiple accounts it remains unresolved, even if the combined balance
  agrees. No allocation is guessed and no history is rewritten.

A missing/disagreeing movement, conflicting source account, missing member,
non-posted movement or incomplete reversal pair requires review. Unknown
account ledger balances are null, never fabricated zero. Unresolved accounts
are excluded from matched counts, and `balanced` is false for any unresolved
journal. Callers must use this flag, not infer success from empty mismatches.
Existing checked/matched/mismatches and numeric mismatch compatibility fields
remain; exact decimal fields, account rows, attribution bases, unresolved
journal details and exact organisation totals are additive.

The ledger basis includes POSTED originals, REVERSED originals, and their
posted counter-entries. The app marks the original REVERSED and creates an
opposite journal: excluding the original counts only the negative reversal.
Both legs now cancel exactly in this reconciliation. The subsequent reversal
report slice aligns trial balance and board-pack reports with this basis; see
recovery-reversal-report-basis.md.

One SQL statement reads all datasets from one MVCC snapshot under existing
withTenant/RLS isolation. Monetary SUM results are cast to text before JSON
aggregation, then processed as unbounded signed integer kobo. Liability totals
remain conserved between attributed and unallocated amounts; a matching total
cannot hide opposite one-kobo product differences or ambiguous attribution.

Analytics shows per-product projections, attributed ledger balances, exact
differences, attribution basis and review reasons. It can refresh reconciliation
without blocking board/portfolio reports. No new permissions, financial write
paths, receipt fingerprints or migrations. Production remains unchanged.

Coverage includes direct deposits/withdrawals, multi-account interest, payroll
posting/atomic reversal, unresolved manual member journals, source movement
corruption, exact large values, read-only operation, tenant isolation, and a
real browser journey with explicit unresolved status and responsive overflow.

Remaining gates: Windows cumulative local acceptance, independent accounting
acceptance, historical data/ordering, independent journal product dimensions
where required, reconciliation of legacy allocations, other report reversal
bases, and performance validation at production volume. This report does not
certify the correctness of historical product choices or running balances.
