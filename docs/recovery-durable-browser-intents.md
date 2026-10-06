# REC-07: durable browser request recovery

Stacked on PR #23. Isolated staging only; no production merge or deployment.

## Result

Staff and member clients retain unresolved financial request keys, original JSON details and server-verified account/cooperative scope in localStorage, shared by tabs in the same browser profile and origin. Closing a tab or restarting that profile does not intentionally discard the request. The browser namespace uses the member ID or normalized staff email; name/profile edits and email casing cannot hide its original request. Server-provided account/cooperative scope remains the authorization boundary. Sign-out hides the original account's records but retains them; sign-in and current server permissions are still required for recovery. No authentication cookie, token, authenticator code or step-up header is persisted in the request record.

An exclusive Web Lock covers legacy migration, account verification, request submission and acknowledgement. A competing financial attempt fails immediately and sends nothing; it never waits and starts a new payment after the first completes. A closed/crashed tab releases the lock while its persistent request remains recoverable. Current scope headers, receipts and natural entity/step retries continue to enforce the server boundary.

Successful acknowledgement removes only the matching key. The recovery panel observes storage changes from other tabs. Changed unresolved details, failed account verification, uncertain responses and refusal after uncertainty retain the original record. Browser storage failures before reservation prevent sending. A failure removing the record after a successful server response leaves it available for original-key replay.

## Upgrade and compatibility

On initial recovery-panel synchronization or financial submission, legacy sessionStorage records and older localStorage display-field namespaces for the current stable identity migrate under the same lock. They are removed from the old tab only after the persistent write succeeds. Conflicting records fail closed and retain both originals; malformed/unbound records need account review. Migrated acknowledgements retain a scoped key marker so an old sessionStorage copy cannot resurrect the completed request. Markers contain no financial body and are not created for ordinary new records.

Reload each previously open staging tab after installing so it imports its old tab record and uses the coordinated client. Already-loaded old application code does not participate in the new lock. Do not clear browser data or overwrite conflicting records while a request is unresolved.

Web Locks require a supported browser in a secure context (HTTPS or localhost). A missing lock API refuses financial submissions; it does not silently fall back to uncoordinated writes. Specification: https://www.w3.org/TR/web-locks/ .

## Verification and remaining gates

Transport regressions cover staff and member persistence with new tab/session storage, concurrent refusal through account verification and acknowledgement, legacy migration/conflicts/scoped acknowledgements, storage failure, stable member identity across profile edits, normalized staff email, migration of older display-field namespaces and unsupported coordination, plus all previous key/step/scope/refusal checks. The real Chromium rehearsal uses two pages in one persistent profile, refuses an overlapping submission, commits a deposit with a lost response, closes its tab, closes and reopens the entire profile, signs in again, verifies byte-for-byte retained records, recovers the original key and observes a second tab clear. It checks one 23-kobo balance and one deposit journal.

This is same-origin, same-profile recovery. Other devices, profiles, private windows and staff/member origins do not share browser records. Server-side intent discovery across devices, browser data eviction/clearing, recovery from older already-lost session records, historical reconciliation, remaining creation/batch/interest/dividend contracts and independent financial/provider/production acceptance remain open. REC-07 stays In progress. No database migration or receipt rewrite is introduced.

User reported PR #23 local RECOVERY UPDATE PASSED on 6 October 2026 at 23:48 Africa/Lagos. Local installer acceptance is separate from independent financial acceptance.
