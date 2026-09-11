# Provider integration guide — building now, connecting later

Co-opEngine runs fully **without** SMS, email or a payment gateway. Those three are
deliberately abstracted so the SaaS can be built, tested and piloted now, and each
one switched on later as **configuration, not code**.

Verified by `apps/api/test/provider-readiness.integration.spec.ts`, which asserts —
with no credentials present — that every provider reports as simulated, that the
whole money loop works, and that setting the right environment variables flips each
channel to live.

---

## 1. What works today with nothing configured

| Capability | Status with no providers |
|---|---|
| Member records, guarantees, branches, KYC vault | ✅ full |
| Savings, shares, loans, payroll, dividends | ✅ full |
| Double-entry ledger, trial balance, period close | ✅ full |
| Reports, statements, board packs (**PDF**) | ✅ full |
| Notifications | ✅ created and queued; delivery simulated |
| Staff portal, member PWA | ✅ full (member login uses a dev OTP) |
| Payment gateway collection | ⛔ not needed — staff record money manually |

**The only hard blocker for real members is SMS.** Everything else is genuinely
usable: staff record contributions and repayments at the counter or from a bank
statement, and the ledger, balances, arrears and reports are exactly as correct as
they would be with a gateway.

## 2. Check readiness at any time

```bash
# from the server
curl -s -H "Authorization: Bearer <staff token>" \
  http://127.0.0.1:3999/api/v1/health/providers | python3 -m json.tool
```
Or in the shell: `scripts/provider-switch.sh status` (SMS/payments) and
`scripts/smtp-configure.sh --status` (email).

The report lists, per provider: mode (`dev`/`live`), which environment variables
are missing, the exact command to enable it, what is simulated meanwhile, and the
features it blocks. It never prints a credential value, and it sits behind auth +
`settings.manage` because "payments are live" is useful information to an attacker.

## 3. How each provider is enabled later

### SMS — Termii (blocks real member login)
1. Termii account + SMS credit + **sender ID registered** (e.g. `COOPENG`)
2. `scripts/provider-set-key.sh` → enter `TERMII_API_KEY`, `TERMII_SENDER_ID`
3. `scripts/provider-preflight.sh --require` → validates balance and sender ID
4. `scripts/provider-switch.sh termii` → restarts the API and verifies `/health`
5. Reverse with `scripts/provider-switch.sh off` or `rollback`

Dev behaviour meanwhile: OTP codes are returned in the API response (`devCode`) and
logged, so staff can complete a member login in a pilot. **That must never reach
real members.**

### Email — Brevo SMTP (nice to have, never blocking)
1. `docs/email-setup.md` for the full runbook
2. `scripts/smtp-configure.sh` (hidden prompt or `--key-file`)
3. `scripts/verify-email-dns.sh` → confirms SPF/DKIM/DMARC
4. `scripts/smtp-configure.sh --test you@address` → real send, real provider response

Dev behaviour meanwhile: notifications are recorded with status `FAILED` and the
provider error. Statements and receipts are already produced as **PDFs** for staff
to hand out, so nothing is lost by not emailing.

### Payments — Monnify (convenience, never blocking)
1. Monnify sandbox/production keys: API key, secret key, contract code
2. `scripts/provider-set-key.sh`, then `provider-preflight.sh --require`
3. `scripts/provider-switch.sh monnify`
4. Product fix already in place: OTP/delivery failures are audit-logged with the
   provider name only — never the code or the member's number

Dev behaviour meanwhile: gateway checkout and webhook collection are simulated.
Staff record contributions and repayments manually; the nightly reconciliation
gate compares the ledger against recorded money.

## 4. The rules that keep late integration cheap

- **No code path may hard-fail on a missing provider.** Verified: the audit found no
  throwing dependency; every channel checks presence of its credentials first.
- **Every provider reads its configuration from the environment**, so switching one
  on is a restart — never a deploy. Credentials are written to a mode-600 file by a
  script that never echoes them, never takes them on the command line, and strips
  CR from Windows pastes.
- **Dev modes must be visible.** The readiness report warns in plain language, and
  `readyForRealMembers` is false while SMS is simulated — so nobody pilots their way
  into onboarding real members by accident.
- **Failures are recorded, not swallowed.** Notifications record provider errors;
  OTP delivery failures are audit-logged with the provider name only.

## 5. Order I would switch them on

1. **Termii (SMS)** — before any real member logs in
2. **Brevo (email)** — before you promise statements or reminders by email
3. **Monnify (payments)** — once cooperatives are collecting at volume and manual
   recording becomes the bottleneck

Each is independently reversible, and none requires touching another.
