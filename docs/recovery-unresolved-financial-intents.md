# REC-07: explicit recovery of unresolved browser financial requests

Requirements: FR-010 contribution posting, FR-011 withdrawals, FR-023 repayments, FR-034 automated journals and FR-044 member experience. This slice extends the durable transactional receipts from PR #19–21. It remains an isolated staging change, with no production merge or deployment.

## Result

Staff and member applications show pending financial requests with a Recover original request action. Recovery resends the original details through the normal authenticated, permission-checked and step-up-protected endpoint. Completed receipts return the original response; requests that never committed may execute once. The panel never offers discard or an action that silently generates a replacement payment key. On acknowledgement it asks the user to refresh the account view: a replayed response is a historical snapshot, not the current balance.

Each new browser intent obtains its account/cooperative scope from the authenticated API and sends that scope on the financial write. Both staff and member authentication guards verify it against their authenticated principal before controller work or receipt replay. This also blocks a sign-in switch between the account lookup and the write. A pending request for another cooperative cannot be rebound to the new session. Account scope is not an authentication credential and cannot grant permissions.

Requests survive reload in the existing tab session storage, including after sign-out. The panel only exposes records for the current browser identity with a signed-in marker. Legacy unbound records remain blocked for review. Explicit caller keys are now also retained. Concurrent preparation reserves the original key before the asynchronous account lookup, preventing a fast acknowledged request from giving a concurrent submission a new key. Delayed preparation cannot overwrite a newer request.

A valid financial JSON response acknowledges the intent. Empty, malformed or scalar success responses retain it. Permission/not-found/server refusals do not clear it. Initial validation refusals may clear a never-uncertain request; validation refusals on later retries retain the original record. Changed details remain blocked while a result is unresolved.

## Verification

Browser transport regressions cover explicit recovery, response loss and reload, account/cooperative switches, legacy records, malformed/empty responses, permission and validation refusals after uncertainty, sign-out/recovery, original approval steps, explicit caller keys and concurrent acknowledgements.

Real PostgreSQL regressions check authenticated scope denial before posting and receipt replay, current authorization on completed receipts, and member scope binding with one pending withdrawal. The existing financial retry suite independently checks one financial effect and receipt across concurrent submissions, rollback and replay.

The isolated Chromium workflow deliberately drops the response after a synthetic 23-kobo deposit commits. It reloads the page, uses the recovery panel and checks the original key, unchanged 23-kobo balance and one deposit journal. It has loopback-only browser routing and a fresh synthetic cooperative. No provider call or production data is involved.

## Remaining acceptance

Separate tabs/devices are not coordinated by this tab-scoped recovery UI. Closing the tab can lose its browser record; durable server receipts remain. There is no receipt enumeration, deletion or historical repair API. Missing or incomplete historical receipts need independent reconciliation. Headerless API compatibility and optional ordinary API keys remain; mandatory external idempotency keys are a further slice. Broader financial/policy/provider and production acceptance remain open. REC-07 is not fully verified.

PR #21 local cumulative installation passed on 6 October 2026 at 22:39 Africa/Lagos; the user confirmed login works at 22:48. Docker responded after offline disk backup and ext4 journal recovery. The rescue backups are retained; database backup restore acceptance is not inferred.
