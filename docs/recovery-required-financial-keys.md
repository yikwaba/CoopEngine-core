# REC-07: mandatory keys on ordinary financial HTTP writes

Requirements: FR-010 contributions, FR-011 withdrawals, FR-023 repayments, FR-034 automated journals and FR-044 member experience. Stacked on PR #22; isolated staging only. No production merge or deployment.

## Contract change

These six POST routes require `idempotencyKey` in the JSON body:

| Route | Financial intent |
| --- | --- |
| `/savings/accounts/:id/deposits` | Savings deposit |
| `/savings/accounts/:id/withdrawals` | Staff withdrawal or withdrawal request |
| `/shares/member/:memberId/purchases` | Share purchase |
| `/shares/member/:memberId/redemptions` | Share redemption |
| `/loans/:id/repayments` | Loan repayment |
| `/member/withdrawals/request` | Member withdrawal request |

Keys must be nonblank strings of 16–100 characters. Missing, null, wrong-type, blank, short and oversized keys return 400. The `pay:` and `withdrawal-request:` prefixes are reserved for trusted internal source links and are refused at the HTTP boundary. External callers cannot select the historical journal-only branch by supplying an internal source key.

Generate and retain one key before sending each new payment. On a timeout, connection loss or uncertain response, resend that same key with the original details. Do not generate a replacement key to retry. The API does not generate a key for an unkeyed request, and an HTTP header alone does not substitute for the body field.

```json
{
  "amount": 5000,
  "description": "October contribution",
  "idempotencyKey": "e6c5ad8f-d2c3-4d22-9457-604f2aef4f35"
}
```

Existing tenant/action receipts atomically commit with the financial effect. Identical retries return the original response; reused keys with different actors, amounts, targets or descriptions conflict. Distinct legitimate payments need distinct keys. Current authentication, permissions, account binding and sensitive-action guards still run before replay.

## Callers and internal operations

Staff/member clients already reserve and retain these keys and offer recovery of the original request. The demo/showcase callers and existing test fixtures now provide explicit keys for genuinely new payments. Deliberate invalid/missing-key tests send their original invalid body unchanged.

Provider callbacks, provider allocation and approved withdrawal payouts continue using trusted internal service calls with their provider/request-derived references. Their atomic provider/decision receipts remain in place. Historical provider fixtures exercise those internal source links directly rather than manufacturing them through an external endpoint. No service-level key is generated automatically or changed, and no historical record is rewritten.

Approval, disbursement and reversal retries already use their entity/step identity with durable receipts; this change does not introduce arbitrary client keys for those transitions. Other creation/batch/interest/dividend paths require their own assessed retry contracts and are not declared complete by this six-route contract.

## Verification and remaining acceptance

Unit validation includes missing-property skipping, invalid values, reserved source prefixes and valid boundary lengths. Real PostgreSQL cases exercise all six HTTP routes with missing, malformed and reserved keys, then compare balances, journals, projections, requests, receipts, audits and counters with the original state. Existing replay/concurrency/fault-injection/provider/approval regressions remain required. OpenAPI tests require generated DTO schemas to mark the retry key as required. The isolated Chromium journey first refuses an unkeyed deposit with no balance effect, then completes the keyed response-loss/reload/recovery journey with one journal.

All prior migrations remain unchanged. Cross-tab/device recovery, historical reconciliation, wider financial route assessment, independent financial/provider/production acceptance and a separately approved production rollout remain open. REC-07 is still In progress.

The user reported PR #22 local RECOVERY UPDATE PASSED on 6 October 2026 at 23:19 Africa/Lagos. Local installer acceptance does not imply independent financial or production acceptance.
