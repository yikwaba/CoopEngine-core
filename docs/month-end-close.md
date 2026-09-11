# Month-end close

Closing a month is the control that turns a running ledger into a reportable
period. Co-opEngine supports the usual two-stage close plus a checklist that has
to be honest before anyone presses the button.

## Period states

| State | Meaning |
| --- | --- |
| `OPEN` | the default — money entries post into it |
| `SOFT_CLOSED` | no new entries; reversible (reopen if something is missing) |
| `LOCKED` | final; cannot be reopened — a correction needs a reversing entry |

Posting into a period is gated on `status = 'OPEN'` by **every** money path
(savings, shares, loans, payments, dividends, payroll, opening balances), so a
closed period simply refuses new entries with a 409 rather than allowing them
quietly.

## API

| Method | Route | Permission |
| --- | --- | --- |
| POST | `/ledger/periods` `{ code: "YYYY-MM" }` | `periods.manage` (idempotent) |
| GET | `/ledger/periods` | any ledger reader |
| PATCH | `/ledger/periods/:id/status` `{ status }` | `periods.manage` |
| GET | `/ledger/month-end-checklist?period=YYYY-MM` | `reports.view` + `journals.create` |

## The checklist

`GET /ledger/month-end-checklist?period=YYYY-MM` returns each item as
`ok` / `warn` / `fail` plus a plain-language detail, and an overall
`readyToClose` flag (false when anything fails):

| Check | Fails when |
| --- | --- |
| **Books balance for the month** | posted debits and credits differ — investigate before closing |
| **No unposted journals** | any entry is still `DRAFT` or `SUBMITTED` |
| **Savings interest posted** | no `INTEREST` transaction in the month (a *warning*: the policy may not require it) |
| **Arrears reviewed** | no arrears run recorded in the month (the nightly job records one) |
| **Every live loan has a schedule** | a DISBURSED/DEFAULTED loan has no instalments |
| **No negative savings balances** | any active account is below zero |
| **Period status** | informational |

## Closing rules

* A period with unposted journals **cannot** be soft-closed or locked (409 with
  the count of offending entries) — post or reverse them first.
* **Locking requires the period to balance** (net within half a kobo of zero).
* A **locked** period cannot be reopened; corrections are made with a reversing
  entry in an open period, preserving the audit trail.
* Every transition is audited (`ledger.period.soft_closed`, `…locked`,
  `…open`) with the previous and new state.

## Operator flow

1. Portal → **Month-end**, pick the period (create it if the month is new).
2. Work through the checklist; fix anything marked `fail`.
3. **Soft-close** to stop entries while you review reports.
4. **Lock** when the committee is satisfied — the month is then immutable.
