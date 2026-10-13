# Parked payment assignment and intent progress

A receipt parked because savings rules prevent crediting now retains its identified member and payment intent. Parking cash does not advance the intent. Staff assignment locks the receipt and its retry record, then locks and validates the intent before domain posting. Member credit, suspense release, exact received-amount increment, intent status, provider status, audit and retry response commit together.

Collections contains a parked-payment form. Known intent links retain their member/purpose. For an unlinked receipt, staff search the member and explicitly choose a compatible intent, or select no intent. The server never guesses an intent during assignment. Current lists are bounded and labelled; payment-intent values display exact decimals.

`paymentIntentId` is an optional assignment field. An existing link cannot be replaced. The selected intent must belong to this cooperative and match the member/purpose. Missing, cancelled or invalid intents refuse assignment without releasing suspense. Distinct receipts may exceed the expected amount, retaining existing overpayment semantics; completion is not a cap. Concurrent cancellation and allocation serialize on the intent row.

The receipt ID remains the natural retry key. The optional field participates in the request fingerprint only when explicitly supplied, preserving old request fingerprints. A committed old assignment is replayed as originally recorded; this change does not retrofit historical progress or fabricate a link. Historical unlinked parked receipts require an explicit selection if progress should advance.

The browser persists the original receipt/member/purpose/intent and financial-account scope across tabs and restarts. An uncertain outcome blocks changed details until original-request recovery. No arbitrary body idempotency key is added to assignment.

## Acceptance

Use isolated staging. A receipt that references an intent but falls below the product minimum should appear in Collections as parked, with that intent linked and received amount unchanged. After an authorized rule correction, assign the receipt once: suspense releases and the intent becomes PARTIAL or MATCHED with the exact received amount. Retry the original assignment or callback; neither amount nor posting count may change.

For an unknown payer, search/select the correct member and explicitly choose the intended reference before assigning. Cancellation or a mismatched member/purpose must leave cash parked. The existing policy decides whether the deposit is eligible; this change does not bypass it.

Automated coverage exercises concurrent distinct/duplicate allocations, automatic matching, cancellation, tenant/routing guards, exact one-kobo arithmetic and injected late failures. Browser coverage uses the real Collections form, committed response loss, a competing tab, persistent-browser restart, exact intent readback and read-only auditor controls.

No migration or historical financial rewrite is included. Historical missing progress, ambiguous links, provider operations and independent financial/production acceptance remain separate recovery work. Production is unchanged.
