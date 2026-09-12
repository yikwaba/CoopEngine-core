# Co-opEngine — Test Guide

Everything below runs on the live system. No setup, no installs: open a browser.

**Generated:** 11 September 2026 **Showcase cooperative:** Sunrise Cooperative Society
(24 members, savings ₦5,325,000, share capital ₦1,165,000, five loans with real arrears, a
withdrawal waiting for approval).

---

## 1. Where to log in

| What | Address |
|---|---|
| **Staff portal** (officers, manager, auditor) | **https://app.coopengine.com.ng** |
| **Member app** (members on a phone) | **https://member.coopengine.com.ng** |
| API (technical) | https://api.coopengine.com.ng/api/v1 · documentation at `/docs` |

`coopengine.com.ng` itself redirects to the portal.

## 2. Logins

| Role | Email | Password | What they can do |
|---|---|---|---|
| **Manager** (start here) | `manager@sunrise.coop` | `Sunrise#2026` | everything, including settings, period close, approvals |
| Treasurer | `treasurer@sunrise.coop` | `rKsyApJrsWES` | collections, deposit posting, loan review, approvals |
| Loan officer | `loans@sunrise.coop` | `pj2yDERvIH-P` | loan applications and repayments |
| Auditor | `auditor@sunrise.coop` | `PK5tvMRSRIob` | read-only, including the audit trail |

The portal also shows a **Cooperative** field — type `sunrise` (or leave it blank: the platform resolves it when you belong to one cooperative).

**Member app:** enter cooperative `sunrise` and email `member01@sunrise.coop`. In this
test build the one-time code is **shown on screen** instead of being sent by SMS (see
*What is simulated* below) — copy it into the code box to sign in.

## 3. A fifteen-minute guided tour

**① Today** — the dashboard opens with four tiles: *Front desk*, *withdrawals awaiting a
second officer* (**1**, ₦80,000), *loans with missed instalments* (**8**), and *close the
month*. That is your morning glance.

**② Front desk** — the counter screen. Click **Front desk**.
Type `Ada` and press *Find member*.
- Her savings balance and loan appear immediately.
- Enter `2000` and press **Take a deposit** → a confirmation, then the balance updates.
- Press **Print statement (PDF)** → a real statement downloads.
This is the whole daily job in one screen.

**③ Members** — *Members* shows all 24 with statuses. Open any member for their record;
`Import CSV` is how a cooperative brings a list of members (the file format is in the
pilot pack).

**④ Loans and arrears** — *Loans*. You will see five migrated loans, one **DEFAULTED** and
four current. Open one and look at its **schedule**: the paid instalments are marked PAID
and the missed ones carry their age. Real cooperatives arrive with history, so the
platform reconstructs it rather than starting from a blank page.

**⑤ Dual control on withdrawals** — *Withdrawals*. There is a ₦80,000 request from a
member. The cooperative's limit is ₦50,000, so it is parked. Press **Approve** →
it posts. Try the same thing as the **same** officer who raised it and the system
refuses (the requester can never approve their own request) — sign in as the treasurer
to see it succeed.

**⑥ Month-end** — *Month-end*. The checklist runs seven checks (books balance, no
unposted journals, interest posted, arrears reviewed …) and reports **ready to close**.
Download the **board pack** as **PDF** (to print) or **Excel** (to pivot). Then
soft-close the month: posting stops but corrections are still allowed, and locking is
final — corrections then become reversing entries, so the audit trail survives.

**⑦ Your own wording** — *Message wording*. Pick *contribution due* and rewrite it in
your cooperative's own voice, using `{{memberName}}`, `{{amount}}`, `{{dueDate}}`.
**Preview** shows exactly what a member receives and how many SMS parts it costs
(messages are charged per 160 characters — three parts cost three times as much).
This demo tenant already has custom wording saved.

**⑧ Notifications and audit** — *Notifications* lists what was sent (or recorded), and
*Audit* shows who did what, when — the first place to look when a figure is questioned.

**⑨ Member app** — open https://member.coopengine.com.ng, sign in as `member01@sunrise.coop`,
and see the member's own view: balance, loan, statements, and a request-withdrawal button.

## 4. What is simulated in this test build

Being clear so nothing looks broken when it is not:

| Area | State | What it means |
|---|---|---|
| **SMS** (OTP, reminders) | simulated | the one-time code appears on screen; no message is sent. Real SMS needs the Termii sender ID. |
| **Email** | recorded only | statements/reminders are produced as PDFs to hand out. Real sending needs Brevo. |
| **Payment gateway** | simulated | officers record deposits and repayments (as they do at the counter); there is no automatic bank/mobile-money collection yet. |
| Everything else | **real** | ledger, balances, arrears, dividends, statements, board packs, month-end close — all the actual machinery, with a real double-entry ledger underneath. |

Nothing here is a mock-up: the numbers you see are computed by the same code that would
run a real cooperative.

## 5. Try to break it (please do)

* Record a deposit of `0` or `-500` → refused with a clear reason.
* Try to approve the withdrawal you raised yourself → refused.
* Post a **second** approval on the same withdrawal → refused (it cannot count twice).
* Re-open a **locked** month → refused; that is the design, not a fault.
* Look for another cooperative's data → you only ever see `sunrise`.

## 6. Notes for you

* **Safe to poke at.** This is a demo cooperative (`sunrise`). If you would like it back
  to a clean state at any point, that is one command on the server:
  `cd /root/CoopEngine-core && scripts/seed-showcase.sh`.
* **Passwords** here are demo passwords. Before real members exist, change them and turn
  on Termii so the one-time codes are actually sent.
* The system is backed by nightly encrypted offsite backups (last verified by restoring
  one), and a watchdog checks certificates, the domain and the backups every few hours —
  it only speaks when something needs attention.
