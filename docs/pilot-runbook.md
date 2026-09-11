# Co-opEngine — Pilot Runbook

For the staff of a cooperative going live on Co-opEngine. One page, five steps,
written to be followed at the counter.

---

## Before you start

| Ask yourself | Why it matters |
|---|---|
| Do we have a clean member list (names, phone numbers, emails)? | Members log in with their **email**; a wrong address is a member who cannot log in |
| Do we know each member's savings, share capital and outstanding loan? | These are the opening balances; the ledger starts from them |
| Have we registered our SMS sender ID? | Member login sends a one-time code by SMS. Without it, only staff can operate (see *Meanwhile* below) |

## Step 1 — Import members

**Members → Import CSV.** Use `member-import-template.csv`.

1. Upload or paste, then **preview**: nothing is created yet, and every bad row is
   reported with its line number and the reason.
2. Fix the rows it flags, preview again, then **commit**.
3. Approve the members who are paid up (**Members → Approve**) — approved members are
   the ones who can transact and log in.

## Step 2 — Post the opening balances

**Opening balances.** Use `opening-balances-template.csv`.

* `savings` and `shares` are what the member already holds.
* `loanOutstanding` is what they still owe. Add `loanTermMonths` and `loanRatePa`.
* `loanPaidCount` brings across how many instalments they already paid, so their
  repayment history is real, not a blank page.
* `loanDaysLate` carries the **arrears** across — the oldest missed instalment is
  placed exactly that many days in the past, so your ageing report is right from
  day one. Loans 90+ days late arrive marked **DEFAULTED**.
* **Preview first**, check the totals against your books, then **post**.

One batch posts once. If a figure is wrong afterwards, record a correcting entry —
the system will not let the same batch count twice.

## Step 3 — Give your officers access

**Users.** Create a login per officer and assign roles:

| Role | Typically does |
|---|---|
| COOP_ADMIN | everything, including settings and period close |
| ACCOUNTANT | ledger, periods, reports, dividends |
| TREASURER | collections, approvals, loan review |
| LOAN_OFFICER | applications and repayment records |
| AUDITOR | read-only, including the audit trail |

Add a name and a phone number to each — the audit trail records who did what.

## Step 4 — Run one month

Everything is recorded by staff at the counter or from the bank statement:

* **Collections** — savings deposits, share purchases and loan repayments, in bulk
  or one at a time. Each carries an idempotency key, so a double-click cannot post
  twice.
* **Withdrawals** — above the limit you set, a request must be approved by a
  *different* officer (the requester can never approve their own).
* **Loans** — apply, review, approve, disburse; guarantors must consent.

## Step 5 — Close the month

**Month-end** shows a checklist before you close:

* books balance · no unposted journals · savings interest posted · arrears reviewed ·
  every live loan has a schedule · no negative balances

Then **soft-close** (posting stops, corrections still allowed), and **lock** once the
committee has seen the pack. A locked period cannot be reopened — corrections are
made as reversing entries, so the audit trail survives.

## Meanwhile: what works before SMS, email and the payment gateway

| Area | Status |
|---|---|
| Members, savings, shares, loans, payroll, dividends, ledger, reports | **fully working** |
| Printed statements, loan schedules, board pack (PDF and Excel) | **fully working** |
| SMS reminders and OTP login for members | needs your **Termii** sender ID |
| Email statements and reminders | needs **Brevo** (config only) |
| Automatic bank/mobile-money collection | needs **Monnify**; until then staff record money manually and the ledger is exactly as correct |

⚠️ **Until SMS is live, member self-service login is a fallback, not a service.**
Pilot with staff-created records and hand out printed statements. Do not invite real
members to log in until the sender ID is registered.

## Weekly and monthly rhythm

| When | What |
|---|---|
| Daily | Record the day's collections; reconcile the total against the bank |
| Weekly | Review the arrears report; chase the oldest bucket first |
| Monthly | Run the month-end checklist, print the board pack, soft-close |
| Quarterly | Verify a restore of the offsite backup (`scripts/verify-offsite-restore.sh`) |

## If something looks wrong

1. Nothing is deleted in this system — look at the **audit log** to see who did what.
2. A wrong posting is corrected with a **reversing entry**, then the correct one.
3. A wrong member detail is edited; the change is recorded.
4. Escalate with: the member number, the date, the amount, and the screen you were on.
