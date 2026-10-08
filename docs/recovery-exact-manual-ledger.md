# Exact manual ledger arithmetic

Manual journal line amounts accept decimal strings across NUMERIC(19,2), up to
99999999999999999.99. Existing numeric inputs remain supported up to
100000000000, with at most two decimal places. Positive amounts and exactly one
side per line are required. Debit and credit totals compare integer kobo;
aggregate totals may exceed one column's range. Inserts use canonical decimal
strings. Trial balance net, month-end balance checks and period locking use
exact SQL decimal sums parsed as integer kobo.

Journal reads add debitDecimal/creditDecimal; trial balance adds balanceDecimal
and netDecimal. Existing numeric response fields remain for compatibility and
may approximate very large values. Consumers needing exact amounts should use
the decimal fields. The actual journal form sends strings and the journal
register displays exact line amounts.

Creation fingerprints preserve the original request types and field order.
Old numeric receipts remain replayable. Changing a number to a decimal string
on an existing key is changed intent and is refused. Submission, posting and
reversal receipt identities are unchanged. Reversal mirrors SQL NUMERIC lines.
No migration, historical rewrite or production deployment is included.

Verification: local API and portal typechecks; 473 API tests, including 30 new
precision/boundary tests; 116 portal/member transport tests. Real PostgreSQL
and isolated Docker browser verification remain pending until CI completes.
Added PostgreSQL cases cover exact storage/posting/read/reversal, large
aggregate trial balance, refusal rollback and numeric receipt compatibility.
Added browser case exercises decimal-string submission and exact line display.
Broader report/export precision and full accounting reconciliation remain open.
