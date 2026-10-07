# REC-07: monthly savings-interest posting retries

Stacked on PR #24; isolated staging only. No production merge or deployment.

## Assessed remaining routes

| Path | Observed behavior | Recovery priority / remaining gate |
| --- | --- | --- |
| `/savings/interest/post` | Exact PostgreSQL numeric accrual and account row locks already exist. A period marker refused retries with 409; no original response receipt existed. The screen sent no body, allowing implicit current-month selection. | This slice: explicit month, atomic durable original-result receipt and browser recovery. |
| `/dividends/post` | Year uniqueness prevents a second completed run, but retries return 409. Preview/post allocation and balance updates still use binary numbers and unlocked read/replace balance updates. | Next: exact nonnegative allocation conservation, deterministic rounding policy acceptance, account locking and atomic year receipts; no completion claimed. |
| `/payroll/import/preview` | Persists a fresh batch for each upload; no retained upload intent key. Approval/rejection/reversal receipts already protect a given batch. | Retain original batch identity on upload retry; repeated-file business policy requires assessment, not global file-content deduplication. |
| `/payroll/import/commit` | Locks a batch and submits it; already SUBMITTED returns 409, later POSTED/REVERSED also conflicts. | Add submission receipt without re-submitting a progressed/reversed batch or changing maker/checker rules. |
| `/loans`, `/member/loans/apply` | A loan application creates a fresh entity; downstream approval/disbursement receipts protect that entity. | Application retry identity must prevent duplicate applications without prohibiting distinct legitimate loans. |
| `/ledger/journals` | Creates a draft entity; downstream approval/reversal receipts protect its transitions. | Draft creation retry identity and original request recovery remain to assess. |

This is a scoped source-path assessment, not authenticated production acceptance or proof that every remaining financial path is enumerated.

## Interest contract and transaction

`POST /savings/interest/post` requires `{ "period": "2026-10" }` with a valid explicit YYYY-MM month. Preview may still select the current UTC month; the screen posts exactly the month it displayed. Missing/null/malformed periods return 400 before financial work. A replay cannot roll over into a newly selected month. No arbitrary client key is required: organization + period supplies the natural financial intent, and the receipt fingerprint binds its actor and month.

The existing tenant transaction atomically commits the receipt, exact interest journal, account credits, savings projections, posting marker, counter and audit. Identical concurrent requests serialize through the receipt and replay the original HTTP 200 result. Later changes to rates/balances or closure of the ledger month do not recalculate an acknowledged run. A changed actor conflicts. Authentication, current grants, sensitive-action checks and server financial scope still run before replay. Failed work/finalization rolls back the receipt with every financial effect, so the original month can be retried after the cause is repaired.

A historical period marker without a complete matching receipt still returns 409 and requires reconciliation. No original response is guessed, no historical receipt is backfilled and no production history is rewritten. A pre-existing incomplete receipt also fails closed. All 45 migrations remain unchanged.

## Browser recovery and verification

The staff client includes interest posting in its existing durable request and cross-tab lock path. Its recovery panel identifies the month and retains original JSON and server-verified account/cooperative scope after a lost response. Changed unresolved months are refused. The period is stored before send and survives browser restart; recovery may complete a never-sent original request, so current authorization and explicit confirmation remain necessary.

Regression coverage: explicit-period validation including missing-property skipping and generated OpenAPI; concurrent same-month replay; no recalculation after rate/balance change or closed period; changed actor/session/scope refusal; invalid/missing month refusal; rollback/retry after closed period or receipt-finalization fault; historical/incomplete refusal; tenant isolation; all previous exact-interest and concurrent-deposit checks. The Chromium journey configures an isolated synthetic product through its authorized API, deposits NGN 1, previews/posts one kobo of interest, deliberately loses its committed response, closes/reopens a persistent browser profile and recovers the original month. It checks one interest journal and NGN 1.01 balance plus observer-tab acknowledgement and overlapping-tab refusal.

Dividend precision/locking/receipt recovery, payroll upload/submission identity, loan/journal creation identity, server-side cross-device recovery, historical reconciliation and independent financial/provider/production acceptance remain open. REC-07 stays In progress.

User reported PR #24 local RECOVERY UPDATE PASSED on 7 October 2026 at 08:05 Africa/Lagos. Local installer acceptance remains separate from independent financial acceptance.
