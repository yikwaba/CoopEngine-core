# Payment reconciliation

Money arriving by transfer, and the problem of knowing whose it is. Before this, a Monnify
webhook posted straight to the payer's savings account and anything it could not attribute was
dropped; a contribution the cooperative was *expecting* had no record at all.

Two records meet here:

- **Payment intent** — money the cooperative expects: a contribution, a loan repayment, a share
  purchase. It carries a short reference (`COOP-1-ISYH`) the member quotes in the transfer
  narration.
- **Provider transaction** — money that actually arrived: a Monnify callback, or an officer
  recording a line they saw on the bank statement.

## How a receipt is placed

1. **Identify the payer** — the member's dedicated virtual account first, then an intent reference
   found in the narration or payer name.
2. **Find the intent** — the quoted reference; failing that, a known member's oldest open intent
   (a repayment if the narration says loan, otherwise savings).
3. **Post it** through the same service the counter uses (`savings.deposit`,
   `loans.captureRepayment`, `shares.purchase`) and close or part-close the intent.
4. **If nobody can be identified** — park the cash: `Dr 1000 Cash at Bank / Cr 2990 Unallocated
   Receipts`, and raise an exception with the reason. The ledger stays balanced and the money is
   visible instead of lost.

An officer can then allocate the exception to a member, which moves it out of suspense with
`Dr 2990 / Cr 2000` (or `1020` for a loan, `3000` for shares).

## The property that matters most

Every posting carries an idempotency key derived from the provider's own reference
(`pay:monnify:<reference>`), and the provider reference is unique per cooperative. **A replayed
webhook cannot pay a member twice** — the second delivery is recognised and reported as a
duplicate rather than posted. This is tested, not asserted.

## Endpoints

| Endpoint | Permission | What it does |
|---|---|---|
| `POST /payments/intents` | `payments.reconcile` + `savings.post` | Record money expected; a reference is generated if none is given |
| `GET /payments/intents?status=&memberId=` | `payments.*` read | Intents, with the member and amounts received |
| `POST /payments/intents/:id/cancel` | `payments.reconcile` | Cancel an open or part-paid intent |
| `POST /payments/transactions` | `payments.reconcile` + `savings.post` | Record a receipt and try to place it |
| `POST /payments/reconcile` | `payments.reconcile` | Retry everything still unmatched |
| `GET /payments/exceptions` | `payments.*` read | Receipts nobody could be identified for |
| `POST /payments/exceptions/:id/assign` | `payments.reconcile` + `savings.post` | Allocate one to a member |
| `GET /payments/reconciliation` | `payments.*` read | Counts and totals by status, plus the unallocated balance |
| `POST /payments/monnify/webhook` | public, signature-verified | Delegates to the same engine |

## Notes for operators

- **The webhook is the only public route** and it verifies Monnify's SHA-512 signature before
  anything else. It stays public on purpose; every other route here needs a staff token.
- **A member with no savings account is not turned away** — the engine opens the cooperative's
  standard savings account for them, exactly as the counter would.
- **Unallocated Receipts is a liability**: the cooperative owes it to whoever sent it. A balance
  that stays there is money someone is waiting to hear about, so the reconciliation summary
  reports it prominently.
