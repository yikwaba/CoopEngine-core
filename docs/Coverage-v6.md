# Co-opEngine — Coverage & Status Report (v6)

**Date:** 11 September 2026
**Supersedes:** Coverage v5 (sprints 33–34)
**Scope of this update:** migrated-loan payment-history reconstruction and Sprint 35 (month-end close).
**Deployment:** live beta — portal `https://app.169.58.196.141.nip.io` · member PWA `https://member.169.58.196.141.nip.io` · API `https://api.169.58.196.141.nip.io/api/v1`

---

## 1. Platform at a glance

| Area | State |
| --- | --- |
| Tenancy | **34 tables under FORCE row-level security**; every tenant query carries the organisation through a transaction-scoped setting |
| Money engine | double-entry ledger, balanced by construction; the trial balance nets **₦0** in every test that posts money |
| Quality gates | **53 integration tests across 28 files**, database tests, unit tests, **5/5 workspace builds**, CI green on every push (58 runs) |
| Delivery | HTTPS with Let's Encrypt certificates, HSTS and security headers; fail2ban jails for SSH and the API |
| Operations | 5 nightly timers — backup 02:17 · offsite 03:10 · arrears 06:15 · notifications 06:30 · watchdog 07:00 |
| Protection | local dumps plus **AES-256 encrypted offsite archives** with verified copies, remote retention and a watchdog that stays silent unless something breaks |
| Onboarding | bulk member import, **opening-balance migration with reconstructed loan history**, KYC document vault, branches |
| Controls | **maker-checker savings withdrawals**, period soft-close and lock, full audit trail |

## 2. Reconstructed loan history (new since v5)

A cooperative's legacy loans rarely arrive as a clean outstanding figure — members
have been paying for months. The migration import now rebuilds **the whole
original schedule**, not merely an ageing position.

New CSV columns: `loanPaidCount` (instalments already settled), `loanPrincipal`
(optional original principal) and `loanLastPaymentDate` (recorded in the audit
trail). Validation rejects whole-number and range violations, an original
principal below the outstanding balance, a future payment date, and a payment
date without a paid count.

On posting, for each migrated loan:

* `loanTermMonths` is treated as the **original** number of instalments;
* the first `loanPaidCount` instalments are inserted as **PAID** with their paid
  principal and interest — genuine history, visible in the loan schedule;
* the remaining instalments are scheduled from the cut-over date, with the
  **first unpaid instalment exactly `loanDaysLate` days overdue**, which places it
  in the correct arrears ageing bucket immediately;
* the unpaid principal sums to the reported outstanding balance **exactly**
  (rounding absorbed by the final instalment) and the complete schedule sums to
  the original principal;
* interest is straight-line (flat) at the stated rate, and the audit trail
  records original principal, instalments paid and remaining, and the last
  payment date.

**Worked example (verified in the test suite):** a 12-instalment loan with 4
instalments paid, ₦80,000 outstanding and the next instalment 20 days late
produces 12 instalment rows — 4 **PAID** (₦40,000 of principal), 8 unpaid
(₦80,000), original principal ₦120,000 — with the 20-day-late instalment in the
**1–30** arrears bucket and a trial balance of **₦0**. The historical instalments
are informational: the opening journal books only the outstanding balance, so the
ledger remains honest.

## 3. Sprint 35 — month-end close

Closing a month is what turns a running ledger into a reportable period.

### Period states

| State | Meaning |
| --- | --- |
| `OPEN` | default — money entries post into it |
| `SOFT_CLOSED` | no new entries; reversible by reopening |
| `LOCKED` | final; cannot be reopened — corrections are reversing entries |

Posting is gated on `status = 'OPEN'` by **every** money path (savings, shares,
loans, payments, dividends, payroll, opening balances), so a closed period refuses
new entries rather than absorbing them quietly.

### The month-end checklist

`GET /ledger/month-end-checklist?period=YYYY-MM` returns each item as
**ok / warn / fail** with plain-language detail, plus an overall `readyToClose`
flag:

| Check | Fails when |
| --- | --- |
| Books balance for the month | posted debits and credits differ |
| No unposted journals | any entry is still DRAFT or SUBMITTED |
| Savings interest posted | no INTEREST transaction in the month (*warning*) |
| Arrears reviewed | no arrears run recorded in the month (*warning*) |
| Every live loan has a schedule | a DISBURSED/DEFAULTED loan has no instalments |
| No negative savings balances | any active account is below zero |
| Period status | informational |

### Closing rules, enforced in the API

* a period with unposted journals **cannot be closed** (409 with the count of
  offending entries);
* **locking requires the period to balance** (net within half a kobo of zero);
* a **locked** period cannot be reopened — a correction is a reversing entry in an
  open period, preserving the audit trail;
* every transition is audited with the previous and new state.

The portal **Month-end** page runs the checklist and offers soft-close, lock and
reopen with confirmation prompts.

## 4. Verification highlights (this update)

| Scenario | Evidence |
| --- | --- |
| Part-paid legacy loan (12 instalments, 4 paid, ₦80,000 outstanding, 20 days late) | 4 PAID rows (₦40,000), 8 unpaid (₦80,000), original ₦120,000, arrears bucket **1–30**, trial balance **0** |
| Clean month checklist | `readyToClose: true`, all six substantive checks present |
| DRAFT journal present | checklist flips to **blocked** (`unposted: fail`) |
| Soft-close with unposted journals | refused **409** |
| Soft-close after posting the entry | **200**, status `SOFT_CLOSED` |
| Deposit into a closed period | refused **409** — the close really stops money entries |
| Reopen then deposit | **200** — work can resume |
| Lock, then attempt to reopen | **409** — locking is final |
| Books after all of it | trial balance **0** |

## 5. Deliberate gaps

1. **Provider keys** — Termii SMS and Monnify payments are wired, rehearsed and
   switched off; the day the credentials exist it is a two-command go-live.
2. **Offsite leg** — tooling complete and rehearsed against a local vault; it
   awaits a Backblaze key to point at the production bucket.
3. **Legacy repayment ledger** — instalments paid are reconstructed as schedule
   history; the old system's individual receipts and payment dates are not
   imported beyond the last-payment date recorded in the audit trail.
4. **Open policy choices** — penalty interest on arrears, dividend payout form
   (savings vs bonus shares), and notification templates remain undecided.

## 6. Recommended next steps

1. **Provider keys** (Termii, Monnify) — roughly fifteen minutes using
   `docs/provider-onboarding.md`, then `scripts/provider-preflight.sh --require`
   and `scripts/provider-switch.sh both`.
2. **Backblaze key** — then `scripts/offsite-enable.sh` performs the supervised
   first upload, verifies the remote hash and updates the watchdog.
3. **Pilot cooperative** — run one real cooperative through sign-up, member
   import, opening balances (with loan history) and a full month of collections.
   This also starts the cloud↔local reconciliation gate.
4. **Close the pilot month** — soft-close, review the reports, then lock, which
   exercises the period state machine with live numbers.
