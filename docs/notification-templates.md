# Message wording (notification templates)

Cooperative staff can word the SMS and email messages members receive, instead of
living with wording baked into the code.

## How it works

* Six notification types can be worded: `CONTRIBUTION_DUE`, `REPAYMENT_RECEIVED`,
  `LOAN_APPROVED`, `LOAN_DISBURSED`, `DIVIDEND_PAID`, `SAVINGS_GOAL_ACHIEVED`.
* Each has **built-in wording** (`apps/api/src/notifications/templates.ts`). A
  cooperative overrides it; nothing depends on a template existing, so a missing row
  simply means "use the built-in text".
* A template is rendered when the notification is *created*, inside the same
  transaction as the business event — so the message and the money commit together.
* Placeholders are `{{name}}`. Numbers are formatted for reading (`5,000.00`).
  **Unknown placeholders are left visible** rather than silently blanked, so a
  preview shows what still needs filling in.
* `{{memberName}}` and `{{organizationName}}` are looked up only when a template
  mentions them, so the usual case costs one indexed lookup.
* Every change is audited (`notification.template.updated` / `.reset`).

## Placeholders by type

| Type | Useful placeholders |
|---|---|
| CONTRIBUTION_DUE | memberName, amount, frequency, dueDate, organizationName |
| REPAYMENT_RECEIVED | memberName, amount, outstanding, organizationName |
| LOAN_APPROVED / LOAN_DISBURSED | memberName, amount, status, organizationName |
| DIVIDEND_PAID | memberName, period, amount, organizationName |
| SAVINGS_GOAL_ACHIEVED | memberName, goalName, target, progress, organizationName |

## API

| Method | Path | Permission |
|---|---|---|
| GET | `/notifications/templates` | `notifications.view` |
| PUT | `/notifications/templates/:code` | `notifications.manage` |
| DELETE | `/notifications/templates/:code` | `notifications.manage` (reset to built-in) |
| POST | `/notifications/templates/:code/preview` | `notifications.view` |

Validation: title ≤ 200 chars, body ≤ 1000 chars, channel `SMS|EMAIL|ANY`. The
preview also reports the **number of SMS parts** (160 characters each), because a
long message costs a cooperative more per send.

Portal: **Message wording** (Notifications section).

## Notes

* SMS length is money. A reminder that spills into three parts costs three times as
  much per member per month.
* Wording is per cooperative and RLS-isolated — one cooperative never sees another's.
* Delivery is unaffected by templates: when Brevo/Termii are not configured, the
  rendered message is still recorded, ready for the day they are.
