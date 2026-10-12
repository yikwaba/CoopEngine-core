# Member withdrawal form and current status — REC-13 / REC-22

The member Savings page now selects an own active account whose product allows withdrawals, accepts the existing bounded numeric amount contract (minimum NGN 1, up to two decimal places), and submits through the existing durable financial transport. Request submission parks a withdrawal for staff review; it does not post a payout.

Unacknowledged submissions keep the original account, amount, reason, key and server scope across tabs and full browser restart. The form is locked until the original request is recovered. Recovery uses the global existing recovery control; acknowledgement clears old form values. Current status is read independently, so replaying an original PENDING acknowledgement cannot replace a later approved/paid or rejected status.

Own request reads add exact amount text, current approval step, step count and engine status. The page shows ordered pending steps, approved-and-paid, rejected-without-payout and the cooperative note, with refresh/focus/event updates and visible-page polling. Reads retain member and tenant scope. At most 200 recent requests are shown; full historical pagination is still open.

Own savings reads add exact account/total/movement decimal fields while retaining legacy numeric fields, and expose the product withdrawal flag used by the selector. Exact total aggregation may exceed a single NUMERIC column limit. The savings view formats decimal text without floating-point conversion. No migration or financial posting/receipt protocol change.

Validation: three PostgreSQL cases cover scoped exact reads and approval progression, rejection notes/no payout and a synthetic above-column aggregate boundary. Six helper checks cover precision and numeric request limits. A new isolated real-browser journey exercises the actual form, blocked product exclusion, invalid amount refusal, cross-tab locking, committed response loss, persistent-profile restart/restored fields, actual treasurer/chairman approval screens, current status through late acknowledgement, rejection notes, selected/other account balances and mobile width. All 13 existing browser steps remain.

Open: richer history/pagination, member withdrawal business rules and reservation policy, verified dual-account person linkage, broader member PWA/session accessibility/offline coverage, policy administration, historical reconciliation and independent finance/production acceptance. No production merge or deployment.
