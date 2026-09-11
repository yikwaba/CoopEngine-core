# Opening balances — migrating an existing cooperative

A cooperative joining Co-opEngine usually arrives with history: members already
saving, share capital already paid up, and loans already running. This module
brings those balances across **once**, with a preview so nothing touches the
ledger until an operator posts it.

* API: `POST /api/v1/migrations/opening-balances/preview`, `POST …/:id/commit`,
  `GET /api/v1/migrations/opening-balances`, `GET …/:id`
* Portal: **Opening balances** (paste or upload the CSV, preview, post)
* Permissions: `migrations.view` / `migrations.manage` (Co-op Admin and
  read-only roles; `settings.manage` also works)

## CSV format

Header row required; column names are case/space-insensitive.

| Column | Required | Notes |
| --- | --- | --- |
| `memberEmail` or `memberNo` | one of them | must match an **ACTIVE** member of the cooperative |
| `savings` | optional | amount currently held for the member |
| `shares` | optional | member's paid-up share capital |
| `loanOutstanding` | optional | principal still outstanding on a live loan |
| `loanTermMonths` | when `loanOutstanding` is set | 1–60; used to rebuild the schedule |
| `loanRatePa` | optional | defaults to the product's rate |
| `loanPaidCount` | optional | instalments already settled in the old system |
| `loanPrincipal` | optional | original principal (inferred from the schedule when omitted) |
| `loanLastPaymentDate` | optional | date of the most recent payment; recorded in the audit trail |

```csv
memberEmail,savings,shares,loanOutstanding,loanTermMonths,loanRatePa
ada@example.com,50000,10000,0,,
bola@example.com,0,0,20000,6,15
```

### Validation rules

* a member reference that matches nobody, or a member who is not ACTIVE, is an **error row**
* negative amounts, non-numeric amounts, duplicate members in one file and
  all-zero rows are **error rows**
* `loanOutstanding` without a valid `loanTermMonths` is an **error row**
* error rows are reported per row with reasons; only valid rows are stored
* a missing required column rejects the whole file with a 400

Preview stores a **PENDING batch**; nothing is posted yet.

## What posting does

One transaction, one journal entry, and per member:

| Effect | Detail |
| --- | --- |
| Savings | account opened if needed; balance increased; `OPENING_BALANCE` transaction recorded |
| Share capital | same, on the member's share account |
| Loans | a **DISBURSED** loan is created with the outstanding principal, term and rate, plus a straight-line schedule (equal principal, flat interest, remainder to the final instalment) |

The journal (balanced by construction):

```
Dr 1000 Cash at Bank            savings + shares brought across
Dr 1020 Loans Receivable        outstanding legacy loans
   Cr 2000 Member Savings Deposits        per member
   Cr 3000 Member Share Capital           per member
   Cr 3200 Opening Balance Equity         equal to the legacy loans
```

`3200 Opening Balance Equity` is created on demand and holds the difference
between what members hold (savings + shares) and what the cooperative holds in
cash — the normal way to book an opening position.

The batch flips to **POSTED** with its journal entry number, and two audit
entries are written (`migration.opening_balances.previewed`,
`…posted`) with the totals. **A batch can only be posted once** — a second
attempt returns 409, so a double-click or a retry cannot double-count a
cooperative's money.

## Operational notes

1. **One batch per cut-over.** If the file was wrong, post nothing and start a
   new preview — batches are immutable once posted.
2. **Reconcile after posting**: the savings book total should equal the sum of
   the migrated savings, and the trial balance must net to zero (it will, since
   the journal is balanced — this is asserted by the integration suite).
3. **Legacy loans** are recorded at the outstanding principal with a fresh
   schedule from the cut-over date; arrears history from the old system is not
   imported. Note any arrangements in the batch label.
4. The import is **per tenant** — RLS isolates batches, and another
   cooperative can never read or post yours (covered by a test).

## Reconstructing a loan's payment history

A legacy loan rarely arrives as a clean "principal outstanding" figure — it has
instalments the member already paid. Give `loanPaidCount` and Co-opEngine rebuilds
the **whole original schedule**:

* `loanTermMonths` is the **original** number of instalments;
* the first `loanPaidCount` instalments are inserted as **PAID** with their paid
  principal and interest, so the loan shows real history rather than a bare
  ageing figure;
* the remaining instalments are scheduled from the cut-over date, with the first
  unpaid one falling exactly `loanDaysLate` days ago;
* the unpaid principal sums to `loanOutstanding` **exactly** (rounding is absorbed
  by the final instalment), and the whole schedule sums to the original principal;
* interest is the straight-line (flat) amount for the stated rate, and the audit
  trail records the original principal, instalments paid/remaining and the last
  payment date.

Example — 12 instalments, 4 already paid, ₦80,000 outstanding, next one 20 days late:

```csv
memberEmail,savings,shares,loanOutstanding,loanTermMonths,loanRatePa,loanDaysLate,loanPaidCount,loanLastPaymentDate
bola@example.com,0,0,80000,12,15,20,4,2026-08-01
```

The loan arrives with 12 instalments (4 PAID = ₦40,000 of principal and interest,
8 outstanding = ₦80,000, original principal ₦120,000), and the 20-day-late
instalment appears in the **1–30** arrears bucket immediately. The historical
instalments are informational: the opening journal books only the outstanding
balance, so the books stay balanced.
