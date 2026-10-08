# Staff withdrawal policy precedence

Previously a staff withdrawal could post immediately when the organisation's
legacy threshold was null or at/above its amount, even with an active WITHDRAWAL
approval policy. Policy lookup occurred only after deciding to park the request.

Staff requests now check for an active stepped policy before immediate posting.
Any active policy makes the engine authoritative: exactly one policy must cover
the amount and have steps, or the entire request transaction rolls back. The same
lookup decision is reused when creating the linked chain. Policy selection and
stored approval amounts receive exact decimal strings from integer kobo rather
than another Number conversion. Public numeric request DTOs remain unchanged.

With no active policy, existing legacy thresholds and immediate staff posting
remain. Member self-service always parks for staff, but still follows its existing
legacy approval path: the engine currently requires a user requester identity.
Member-to-engine integration is an explicit remaining REC-08/13 gap, not completed
by this staff fix. Policy administration also has no normal UI yet; synthetic
policy fixtures are seeded only in disposable tenant-scoped tests/staging.

Existing maker-checker, ordered role steps, final-step-only payout, atomic posting,
request/decision receipts and expected-step checks remain. Retry of an already
committed pre-fix receipt returns its historical result; this change does not undo
or repost history. No new migrations or production merge/deployment.

PostgreSQL regressions cover null/high/equal legacy thresholds, inclusive upper
policy bound, gap/overlap/no steps rollback, inactive/no-policy compatibility,
self/wrong-role/stale-step refusal, concurrent retries and tenant isolation. The
real browser journey uses the inbox and withdrawal screens for treasurer then
chairman decisions and checks exact balances and savings reconciliation.

Remaining gates: local cumulative acceptance, member requester identity and
engine integration, policy administration UI/lifecycle/concurrent edits, historical
bypass review, broader approval/loan/withdrawal controls and independent financial
and production acceptance. Next slice: enable policy-backed member withdrawal
requests with explicit member identity and end-to-end authorization coverage.
