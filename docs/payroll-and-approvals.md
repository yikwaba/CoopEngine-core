# Payroll approval, reversal, and the approvals inbox

## Payroll: nothing posts on one person's say-so

The master prompt asks for upload → validation → **approval** → atomic posting → **reversal**. The
first two existed; the last three did not. Now:

```
import/preview  -> PREVIEWED   (control totals, nothing written)
import/commit   -> SUBMITTED   (a second pair of eyes is required)
batches/:id/approve -> POSTED  (atomic; approver must not be the submitter)
batches/:id/reject  -> REJECTED (with a reason)
batches/:id/reverse -> REVERSED (every entry it created is reversed)
```

- **Approval is not a formality.** A batch must be `SUBMITTED` before it can post, and the approver
  must differ from the person who submitted it — `409 A payroll batch must be approved by a
  different user (segregation of duties)`.
- **Posting is atomic**: one transaction, so a batch never half-posts.
- **Reversal gives the money back, not just the books.** Reversing the journal entries balances the
  ledger, but the members' savings balances are moved by the savings side of the posting, so the
  reversal credits each account back and writes a matching savings transaction. If a member has
  already spent the money the reversal **refuses** with a named member rather than quietly leaving
  a negative balance — that is a conversation for an officer, not a silent adjustment.
- **The batch records the entries it created** (`journal_entry_ids`), so a reversal undoes exactly
  those and nothing else.
- **History is visible**: `GET /payroll/batches` shows filename, status, totals, who submitted,
  who approved, and why it was rejected or reversed.

## The approvals inbox

`GET /approvals` answers "what needs my decision?" — one list gathering the queues that already
existed:

| Type | Source | Decided by |
|---|---|---|
| `WITHDRAWAL` | `savings_withdrawal_requests` PENDING | its own screen, or the withdrawals API |
| `LOAN` | `loans` PENDING | its own screen, or the loans API |
| `JOURNAL` | `journal_entries` SUBMITTED | `POST /approvals/journals/:id/approve` |
| `PAYROLL` | `payroll_batches` SUBMITTED | `POST /approvals/payroll/:id/approve` or `/reject` |

Each item carries `reference`, `amount`, `requestedBy`, `ageHours`, the `actionBase` where its
action lives, and — importantly — **`canAct` with a `blockedReason`**:

- missing the permission → *"Requires the payroll.approve permission"*
- being the person who raised it → *"You raised this — someone else must decide it"*

That second case matters: an inbox that offers a button which then refuses is worse than no
button. Segregation of duties is applied where the owning module enforces it (withdrawals,
payroll).

The inbox invents no state machine: every action **delegates** to the module that owns the
decision, so maker-checker rules live in exactly one place each and an approved item leaves the
queue as a matter of course.
