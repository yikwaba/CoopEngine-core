# Unambiguous automatic payment matching

Automatic intent allocation requires exactly one complete reference quoted in the receipt narration. Matching is case insensitive and treats letters, digits, underscore and hyphen as reference-token characters. Payer names do not identify an intent. Prefix fragments, multiple references and case-insensitive collisions cannot select the first candidate.

The intent must agree with the virtual-account member, when one is known. OPEN/PARTIAL status is rechecked under an intent row lock before posting. Contradictory identities, ambiguous/unquoted competing intents, unknown COOP references, inactive quoted intents and unreferenced non-savings purpose hints park real cash in suspense with a visible reason. They do not increment progress or credit a member. Duplicate receipt callbacks replay that outcome once.

A unique virtual account with no open intent competing retains ordinary unreferenced savings behavior. Matching observes the tenant's current routing snapshot; this is not a reservation mechanism or a new allocation priority. Arbitrary unrecognized custom narration has no universal reference syntax. Amount similarity and loan/share words never choose a payment intent.

Collections lets authorized staff resolve unlinked ambiguity through explicit member/purpose/intent selection. Matched/cancelled quoted intents remain linked for review; cancelled links refuse assignment, while explicit additional receipts on a funded intent retain existing overpayment semantics. Cached historical outcomes and postings are not rewritten.

## Verification

Unit tests cover complete-token boundaries, Unicode word extensions, literal regex characters, multiple/colliding references and deterministic virtual-account policy. PostgreSQL coverage checks balanced suspense, exact intent/member projections, duplicates, contradictory routes, closure concurrency and signed ambiguous callbacks. Browser coverage exercises visible reasons and explicit staff allocation through Collections, with exact member balance and intent readback.

No migration, historical rewrite or production deployment is included. Broader provider/sandbox/settlement/refund reconciliation and historical ambiguous allocations still require independent review.
