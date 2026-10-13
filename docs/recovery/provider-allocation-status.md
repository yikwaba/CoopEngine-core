# Provider receipt state after allocation

New signed callbacks parked in suspense store notification status PARKED. An allocation updates matching notification status and journal link with provider state, domain credit, suspense release, intent progress, audit and retry receipt in the same transaction. Only same-cooperative MONNIFY transaction reference, virtual-account number and exact amount identify a notification. All exact delivery aliases follow the same allocation; raw payload, original bank-account member, references and paid-at evidence remain unchanged.

Callbacks lock the provider receipt before notification rows. Duplicate identity validation happens after reconciliation inside the same transaction; a conflicting notification still rolls the entire operation back. This matches allocation lock ordering and prevents notification/provider lock cycles during retries.

Collections projects current status from the correlated provider receipt and its posted journal. Legacy stored FAILED notifications can therefore display current PARKED/POSTED without rewriting historical records. Missing/mismatched routing or journal links require review. The API retains stored status/journal provenance separately and adds exact amountDecimal beside the existing numeric amount.

The Collections feed refreshes on financial request events and has an explicit refresh button. The member's own bank-receipt list uses the same current-state projection, exact amount and visible status, without a plus sign suggesting that parked cash has credited a balance. A receipt redirected after cooperative review is labelled ALLOCATED_ELSEWHERE for its original bank-account member, without revealing the destination member. Bank-account ownership/evidence remains intact; destination savings movements remain on the credited account.

## Acceptance

In isolated staging, a signed below-minimum callback appears as Parked — awaiting allocation. After an authorized rule correction and staff allocation, Collections displays Allocated with the current domain journal and the member receipt displays the new state. A lost response remains recoverable under the original request; retry and duplicate callback cannot add credit or progress. Refused or failed allocation must keep the receipt parked.

Database tests cover notification-update rollback, callback/allocation concurrency, aliases, provider/tenant correlation, conservative legacy reads, inconsistent links, redirected member privacy and large exact decimals. Browser coverage exercises actual staff/member receipt views, committed response loss, original recovery, duplicate callback, exact balances, mobile width and reconciliation.

No migration or historical money rewrite is included. Current-state projection is not independent historical financial reconciliation. Reversal/refund/settlement/provider-sandbox acceptance remains separate. Production is unchanged.
