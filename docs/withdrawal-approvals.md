# Savings withdrawals with dual control (maker-checker)

A cooperative's savings are its members' money, so a single officer should not be
able to move them alone. Every withdrawal path now honours an organisation-level
policy and, when it applies, parks the request until a **different** person
approves it.

## The policy

`organizations.withdrawal_approval_threshold` — set from the portal
**Withdrawals** page or `PATCH /api/v1/savings/settings/withdrawal-approval`:

| Value | Meaning |
| --- | --- |
| `null` (default) | no approval needed — withdrawals post immediately, exactly as before |
| `0` | **every** withdrawal needs approval |
| `N > 0` | withdrawals **above ₦N** need approval; smaller ones post immediately |

The policy is enforced inside the withdrawal endpoint itself, so it cannot be
bypassed by calling the API directly.

## The flow

1. A member or officer raises a withdrawal → `savings_withdrawal_requests` row,
   status **PENDING**. No money moves, no journal is written.
2. Staff see the queue (`GET /api/v1/savings/withdrawals?status=PENDING`, or the
   portal page) with the member, amount, reason and who raised it.
3. A user holding `savings.approve` either:
   * **approves** → the withdrawal is posted through the normal savings path
     (ledger `Dr 2000 Member Savings / Cr 1000 Cash`, savings transaction,
     balance update) and the request is marked APPROVED with its journal entry, or
   * **rejects** → the request is closed with notes; the balance is untouched.
4. Both decisions are audited (`savings.withdrawal.approved` /
   `…rejected`), and so are policy changes and every request.

## Controls that are enforced, not documented

* **Segregation of duties** — the person who raised a request can never approve
  it; the API returns 409.
* **Posted at most once** — approval uses an idempotency key derived from the
  request id, so a retry or double click cannot pay twice (409 on replay), and
  the request status is checked under a row lock.
* **Funds check at approval time** — the balance is re-checked when the approval
  posts, so a member cannot withdraw money that has since been used.
* **Members always need staff** — member self-service requests are ALWAYS parked
  for approval, whatever the threshold says, and a member token can never approve.
* **Tenant isolation** — requests are RLS-protected like every other table.

## Members

* `POST /api/v1/member/withdrawals/request` `{ amount, description? }` — the
  member's primary active savings account is resolved automatically.
* `GET /api/v1/member/withdrawals` — the member's own requests and their status.
* The member PWA has a **Request a withdrawal** card with the recent history.

## API summary

| Method | Route | Permission |
| --- | --- | --- |
| POST | `/savings/accounts/:id/withdrawals` | `savings.withdraw` (posts or parks per policy) |
| GET | `/savings/withdrawals?status=&memberId=` | `savings.withdraw` / `savings.approve` |
| POST | `/savings/withdrawals/:id/approve` | `savings.approve` |
| POST | `/savings/withdrawals/:id/reject` | `savings.approve` |
| GET/PATCH | `/savings/settings/withdrawal-approval` | `savings.withdraw` / `savings.approve` |
| POST/GET | `/member/withdrawals/request`, `/member/withdrawals` | member token |

`TREASURER` and `CHAIRMAN` hold `savings.approve` out of the box.
