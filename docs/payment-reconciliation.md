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

An officer can then allocate the exception to a member. The suspense release and domain posting
commit together, with a net `Dr 2990 / Cr member destination` and no additional cash; loan payments
use the normal principal/interest split. See the recovery details below.

## The property that matters most

Every posting carries an idempotency key derived from the provider's own reference
(a tenant-scoped hash of the full reference), and the provider reference is unique per cooperative. **A replayed
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

## Recovery: atomic allocation and retry receipts

Provider ingestion, domain posting, payment-intent totals and provider matching state now share
one tenant transaction. The signed webhook also writes its provider notification in that same
commit. A failure returns an error and rolls everything back so the callback can retry. Matching
an already recorded `UNMATCHED` transaction is serialized by its row lock and protected by a
completed `provider.match` financial receipt. Parked exceptions stay in suspense until assigned.

Duplicate provider references return the current settled outcome with `duplicate: true`; they
never increment an intent or post again. Reusing a reference with changed amount, payer or routing
fields conflicts. Webhook payment-reference reuse with a different transaction/account/amount
also conflicts. New journal keys hash the full provider reference, tenant and operation rather
than truncating references or sharing keys across cooperatives.

Exception assignment locks the provider transaction and uses a durable `provider.assign` receipt
bound to the member and purpose. Identical retries return the original response, while changed
member/purpose conflicts. It verifies the original posted suspense journal against the receipt,
then runs the existing savings, share or loan service inside the same transaction. Thus the member
balance, movement, loan principal/interest schedule, notification and audit are updated together.

Assignment creates two balanced entries in one commit: the regular domain posting (`Dr 1000 /
Cr member destination`) and a linked suspense release (`Dr 2990 / Cr 1000`). Combined, these are
`Dr 2990 / Cr member destination` with **zero additional cash**. Loan repayments split principal
and interest using the normal repayment allocation rules. The response includes `entryId` for
the release and `journalEntryId` for the domain posting; the provider row links to the latter.

No schema migration is needed beyond the existing financial receipts migration 0045. Existing
historical partial postings or allocations without consistent state/receipt links fail closed
and require independent reconciliation; this change does not repair historical data. All changes
remain on the draft recovery branch until separately accepted for production.
