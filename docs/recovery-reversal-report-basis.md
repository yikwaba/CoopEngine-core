# Append-only reversal basis in financial reports

A reversal marks its original journal REVERSED and posts a linked opposite
journal. The original remains part of the ledger. POSTED-only sums incorrectly
count the counter-entry without the original, even though the global net of
individually balanced journals can still be zero.

Trial balance, board-pack JSON/CSV counts and net, board-pack XLSX turnover and
net, and PDF board-pack net now include both POSTED and REVERSED journals.
Draft/submitted journals remain excluded. A reversal of a reversal contributes
each journal exactly once; no chain is collapsed or amount inferred. Gross
Excel debit/credit turnover includes both legs while the account net cancels.
Exact SQL numeric sums and integer-kobo decimal text remain unchanged.

Existing trial-balance period filters remain. Reversals use the original period
and date under current posting policy; this slice does not permit closed-period
adjustments. Board-pack ledger summaries retain their existing all-time scope;
its period label does not make those ledger amounts a period-specific trial
balance. Existing month-end balanced checks and period-lock net checks use the
same posted/reversed basis. No other period state or approval rule changes.

Tenant-scoped transactions/RLS, report permissions, response fields and journal
list status filters remain. Entry counts include originals plus counter-entries.
No migration, historical mutation, new financial write path or production rollout.

Regression coverage uses real posted/manual and payroll reversals, large exact
turnover and one-kobo correction, reversal chains, draft/submitted exclusion,
period filtering, tenant isolation, read-only snapshots and actual browser
CSV/XLSX/PDF downloads. A zero global net alone is not accounting acceptance.
Historical incomplete reversal pairs, source projection discrepancies and product
allocation require separate review. PR34 savings reconciliation already flags
incomplete pairs; the general trial balance reports ledger facts without guessing
missing history.

Remaining work includes independent accounting/historical reconciliation,
period-close/reopen policy and UI, normal-UI trial-balance/account configuration,
production-volume performance and financial/provider acceptance. Suggested next
slice: close the withdrawal approval-policy bypass with normal workflow and
maker/checker coverage (REC-08/13), after this cumulative update is accepted.
