# Co-opEngine — Coverage & Status Report (v5)

**Date:** 11 September 2026
**Scope:** sprints 33 and 34 plus the operational hardening completed after the v4 report.
**Deployment:** live beta on `https://app.169.58.196.141.nip.io` (portal), `https://member.…` (member PWA), `https://api.…/api/v1`.

---

## 1. Where the platform stands

| Area | State |
| --- | --- |
| Tenancy | **34 tables under FORCE row-level security**; every tenant query carries the org via a transaction-scoped GUC |
| Money engine | double-entry ledger, balanced by construction; trial balance nets ₦0 in every test that posts |
| Quality gates | **51 integration tests across 27 files**, 3 db tests, unit tests, 5/5 workspace builds, CI green on every push (55+ runs) |
| Delivery | HTTPS with Let's Encrypt, HSTS and security headers; fail2ban jails for SSH and the API |
| Operations | 5 nightly timers: backup 02:17 · **offsite 03:10** · arrears 06:15 · notifications 06:30 · **watchdog 07:00** |
| Protection | local dumps + **AES-256 encrypted offsite archives** with verified copies, remote retention, and a silent-unless-broken watchdog that messages the operator |
| Onboarding | bulk member import, **opening-balance migration** for existing cooperatives, KYC document vault, branches |

## 2. Sprint 33 — opening-balance migration

A cooperative joining the platform brings its history across in one previewed,
auditable step. Preview validates every row (unknown or inactive member,
negative/non-numeric amounts, duplicates, all-zero rows, loans without a term,
missing columns) and stores only the valid rows in a PENDING batch; posting runs
in a single transaction.

Posted effects: savings and share balances credited (accounts opened on demand,
`OPENING_BALANCE` transactions), legacy loans recreated as DISBURSED with a
straight-line schedule, and one balanced journal:

```
Dr 1000 Cash at Bank          savings + shares brought across
Dr 1020 Loans Receivable      outstanding legacy loans
   Cr 2000 Member Savings                per member
   Cr 3000 Member Share Capital          per member
   Cr 3200 Opening Balance Equity        equal to the legacy loans
```

**Decisions applied on request (2026-09-11):**

* **Past-due flags carry across.** `loanDaysLate` (and the legacy
  `loanArrearsAmount` for reference) are imported; the schedule is anchored so the
  oldest missed instalment is exactly that many days overdue, which puts it in the
  right arrears ageing bucket immediately. A loan already **90+ days** behind
  arrives **DEFAULTED**, mirroring the nightly arrears job.
* **Straight-line method.** Migrated loans are pinned to `FLAT` (equal principal,
  flat interest) regardless of the source product, and the method is recorded in
  the audit metadata.

Batches are immutable: a second post returns **409**, so a retry cannot
double-count a cooperative's money. Cross-tenant reads return 404.

## 3. Sprint 34 — savings withdrawals with dual control

A cooperative's savings are its members' money, so one officer should not be able
to move them alone. The organisation setting
`withdrawal_approval_threshold` decides the policy:

| Value | Meaning |
| --- | --- |
| `null` (default) | withdrawals post immediately — unchanged behaviour |
| `0` | every withdrawal needs approval |
| `N > 0` | withdrawals above ₦N need approval |

Controls that are **enforced, not merely documented**:

* the policy is applied inside the withdrawal endpoint itself, so it cannot be
  bypassed by calling the API directly;
* **segregation of duties** — the requester can never approve their own request (409);
* **posted at most once** — approval uses an idempotency key derived from the
  request id, and the request status is checked under a row lock, so a retry or a
  double click cannot pay twice;
* **funds re-checked at approval time**, so money used in the meantime cannot be
  withdrawn again;
* **members always need staff** — member self-service requests are always parked,
  and a member token can never approve.

Approval posts through the normal savings path (`Dr 2000 Member Savings /
Cr 1000 Cash`) and links the resulting journal entry to the request. Both
decisions, every request and every policy change are audited. The portal has the
approvals queue and the policy editor; the member PWA has a request card.

## 4. Verification highlights

| Scenario | Evidence |
| --- | --- |
| Opening balances: 4-row file (2 valid, unknown member, negative) | totals 4/2/2 with per-row reasons |
| Posting opening balances | savings book **50,000**, loan DISBURSED **20,000** over 6 instalments summing exactly, trial balance **0**, replay **409**, foreign tenant **404** |
| Arrears carry-over: 45 days late / 120 days late | first missed instalment 45 days old in the **31–60 bucket**; the 120-day loan arrives **DEFAULTED**; method `FLAT` |
| Withdrawals with policy off | posts immediately, balance 100,000 → 90,000 |
| Policy above ₦5,000 → ₦25,000 request | parked PENDING, **balance unchanged** |
| Self-approval attempt | **409**, balance still unchanged |
| Approval by a different user | balance 90,000 → **65,000**, journal entry linked |
| Approve replay | **409**, still 65,000 — never pays twice |
| Rejection | status REJECTED, balance unchanged |
| Member self-service request | parked PENDING; member token **cannot** approve |
| Books after all of it | trial balance nets **0** |

## 5. Deliberate gaps (unchanged or newly noted)

1. **Provider keys** — Termii SMS and Monnify payments are wired, rehearsed and
   switched off; the day the credentials exist it is a two-command go-live.
2. **Offsite leg** — the tooling is complete and rehearsed against a local vault;
   it awaits a Backblaze key to point at the real bucket.
3. **Legacy arrears history** — the ageing position is carried across, but a full
   repayment ledger from the old system is not reconstructed.
4. **Penalty interest** on arrears, dividend payout form (savings vs bonus
   shares) and the SMS/email templates remain open policy choices.

## 6. Suggested next steps

1. **Provider keys** — the last functional gap; ~15 minutes with `docs/provider-onboarding.md`.
2. **Backblaze key** — then `scripts/offsite-enable.sh` does the supervised first upload.
3. **Pilot cooperative** — run one real cooperative through sign-up, member
   import, opening balances and a full month of collections; that also starts the
   cloud↔local reconciliation gate.
4. **End-of-month close** — soft-close and lock a period with real numbers, which
   exercises the period state machine with live data.
