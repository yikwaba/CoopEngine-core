# Security policies a cooperative controls

Two controls from the platform decision log were implemented in code but never *enforced*:
two-factor authentication for staff (decision 9) and step-up verification for actions that move
money or rewrite the books (decision 9). Both are now real switches a cooperative owns, and
both default to **off** so no cooperative is locked out by an upgrade.

## The switches

| Setting | Default | What it does when on |
|---|---|---|
| `security.mfaRequiredForPrivilegedRoles` | `false` | A staff sign-in to this cooperative is **refused** until the user has enrolled an authenticator app |
| `security.requireStepUpForSensitiveMoney` | `false` | Disbursing a loan, posting a journal entry and reversing one require a **live six-digit TOTP code** with the request |

Read and change them:

```bash
# read (any admin of the cooperative)
GET /api/v1/settings          # -> { currency, timezone, settings: { security: { ... } } }

# turn the MFA requirement on
PATCH /api/v1/settings
{ "security": { "mfaRequiredForPrivilegedRoles": true } }

# require step-up for money actions
PATCH /api/v1/settings
{ "security": { "requireStepUpForSensitiveMoney": true } }
```

Both routes require the `settings.manage` permission — only a cooperative administrator can
change its own policy. Updates **merge** rather than replace, so setting one switch cannot
silently clear the other. Every change is written to the audit trail as `settings.updated`
with the exact payload.

## Who counts as "privileged"

Every staff role that can open the portal: `COOP_ADMIN`, `TREASURER`, `ACCOUNTANT`,
`LOAN_OFFICER`, `CREDIT_COMMITTEE`, `AUDITOR`, `CHAIRMAN`, `SECRETARY`. Members sign in
through the member app with a one-time code and never reach these endpoints, so they are not
part of this policy.

## What step-up protects

| Action | Endpoint |
|---|---|
| Loan disbursement | `POST /loans/:id/disburse` |
| Journal posting | `POST /ledger/journals/:id/approve-post` |
| Journal reversal | `POST /ledger/journals/:id/reverse` |

Send the code as `"otp": "123456"` in the request body. When the switch is off the field is
ignored, so clients can send it unconditionally.

### Refusals you will see

| Situation | Response |
|---|---|
| Code required and absent | `403` — "a step-up verification code is required to …" |
| Code wrong | `401` — "Invalid step-up verification code", audited as `stepup.failed` |
| Code malformed | `400` — `otp must be a six-digit code` |
| MFA not set up on the account | `403` — step-up would be meaningless, so the account must enrol first |
| Sign-in blocked by the MFA policy | `403` — "…requires two-factor authentication for staff…", audited as `mfa.login_blocked` |

A successful step-up is audited as `stepup.verified` with the action it authorised.

## Before you switch MFA on

1. Make sure the administrators can enrol: they need an authenticator app and access to
   `POST /api/v1/auth/mfa/setup` → `POST /api/v1/auth/mfa/verify-setup`.
2. Turn the switch on for **one cooperative first** and confirm a sign-in is refused and an
   enrolled sign-in succeeds.
3. Remember it applies to *every* staff account of that cooperative, including any you create
   later. This is the point of the control — and it is why the default is off.

## How this is verified

`apps/api/test/security-policies.integration.spec.ts` proves the enforcement, not the code:

- settings are readable and writable by an administrator only (`403` for a loan officer)
- with the policy on, a staff sign-in without an authenticator is refused, and allowed again
  the moment the switch is turned off
- step-up refuses a journal posting with no code (and names MFA when the account has none)
- with a real authenticator enrolled and a **live TOTP code**, step-up passes and the request
  reaches the service layer; a wrong code does not
- refusals and successes land in the audit trail
