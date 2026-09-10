# Provider go-live — Termii (SMS OTP) & Monnify (virtual accounts)

Everything in the codebase is already wired and tested **against local mocks**
(`apps/api/test/provider-mocks.integration.spec.ts` proves the live code paths:
Termii SMS delivery incl. outage handling, Monnify POST auth + reserved-account
creation + signed webhook auto-posting). The only remaining work is provider
onboarding — which needs a human with documents.

---

## 1. Termii (member SMS OTP)

**Sign up:** https://termii.com → create account (business info: company name,
email, phone). Verify email/phone.

**Get credentials:**
- Dashboard → *Settings → API Keys* → copy the **API key** (`TERMII_API_KEY`)
- Dashboard → *Sender IDs* → request a Sender ID (e.g. `CoopEngine`). Nigerian
  networks require sender-ID approval — use the default/test sender until live.
- Top up SMS credits (send test SMS in the dashboard first).

**Env file** (`/root/coopengine/providers.env`, chmod 600 — you write it):

```
TERMII_API_KEY=<from dashboard>
TERMII_SENDER_ID=CoopEngine
TERMII_TEST_PHONE=+234XXXXXXXXXX     # optional: preflight sends one test SMS
```

**Activate:**
```
MEMBER_OTP_PROVIDER=termii
```
Then: `bash scripts/provider-preflight.sh` → then restart the API
(`systemctl --user restart coopengine-api`).

**Requirement:** members need `phone` populated for SMS delivery (the member
import CSV and the create-member form support it). Members without a phone
receive a generic "not sent" response.

**Cost note:** Termii is prepaid; SMS to Nigeria ≈ ₦4ish/segment. Budget a small
top-up for beta.

---

## 2. Monnify (virtual accounts / bank-transfer collections)

**Sign up:** https://monnify.com → *Create a business account*. Monnify requires
**business KYC** (CAC registration number, TIN, director details, bank account
for settlement). For Co-opEngine, the cooperative itself is the merchant — you
likely want to register the **cooperative's** CAC entity, or start with
Monnify's **sandbox** which needs no KYC.

**Sandbox first (recommended):**
- Dashboard → *Developer → API Keys* → copy **Sandbox API key** and **Secret key**
- Copy the **Contract Code** (sandbox)
- Base URL: `https://sandbox.monnify.com`

**Env** (`/root/coopengine/providers.env`):

```
MONNIFY_API_KEY=<sandbox or live API key>
MONNIFY_SECRET_KEY=<sandbox or live secret key>
MONNIFY_CONTRACT_CODE=<contract code>
MONNIFY_BASE_URL=https://sandbox.monnify.com     # live: https://api.monnify.com
MONNIFY_PROVIDER=monnify
```

**Webhook registration (critical):** Monnify dashboard → *Developer → Webhooks*
→ set the webhook URL to:

```
https://<your-domain>/api/v1/payments/monnify/webhook
```

The API verifies `monnify-signature: sha512(secretKey + "|" + rawBody)`; it
dedupes on `paymentReference`, acknowledges unknown accounts silently, and
auto-posts successful transfers as `Dr 1000 / Cr 2000`.

**Activate:** restart the API, then create a virtual account from the portal
(*Collections → Issue a virtual account*) and make a test transfer (sandbox has
test-transfer tooling).

---

## 3. Checklist

- [ ] `providers.env` written (chmod 600, never committed)
- [ ] `bash scripts/provider-preflight.sh` → no failures
- [ ] `MEMBER_OTP_PROVIDER=termii` + a real OTP received on a member phone
- [ ] `MONNIFY_PROVIDER=monnify` + a sandbox virtual account created
- [ ] Test transfer auto-posted to savings + reconciliation shows 0 mismatches
- [ ] Monnify webhook URL registered in the dashboard
- [ ] Providers' credentials stored only in `providers.env` (root-only)

## 4. Rollback

Set `MEMBER_OTP_PROVIDER=dev` / `MONNIFY_PROVIDER=dev` (or remove the vars) and
restart — the dev providers have no external dependencies, so the platform keeps
working while provider issues are sorted out.

---

## Deployment checklist (run these the day the keys exist)

Everything below is rehearsed end-to-end with dummy credentials — the guards,
the rollback, the failure path and the dev-provider recovery are all proven.

### 1. Store the credentials (never pasted into chat)

```bash
cd /root/CoopEngine-core
scripts/provider-set-key.sh TERMII_SENDER_ID      # approved sender ID (<= 11 chars)
scripts/provider-set-key.sh TERMII_API_KEY        # hidden prompt, trimmed, masked confirmation
scripts/provider-set-key.sh MONNIFY_API_KEY
scripts/provider-set-key.sh MONNIFY_SECRET_KEY
scripts/provider-set-key.sh MONNIFY_CONTRACT_CODE
# optional: TERMII_TEST_PHONE to have the preflight send one real SMS
scripts/provider-switch.sh status                 # shows flags + masked credentials + warnings
```

The entry script reads from a hidden prompt (or piped stdin), strips CR/whitespace
from Windows pastes, validates length/shape, writes atomically to the root-only
`providers.env` (mode 600) and prints only a masked confirmation.

### 2. Validate before switching

```bash
scripts/provider-preflight.sh            # exits 1 on a bad credential, 0 with skips
scripts/provider-preflight.sh --require  # exits 2 if anything is still missing (the gate)
```

It calls Termii's balance endpoint and Monnify's `POST /api/v1/auth/login`
(the real auth verb), building the Basic header in-process so the secret never
appears in the shell history, and optionally sends one test SMS.

### 3. Switch and verify

```bash
scripts/provider-switch.sh termii    # or monnify | both
#   * refuses to enable a provider whose credentials are missing (exit 3)
#   * keeps providers.env.bak, restarts coopengine-api, checks /health, prints status
scripts/provider-switch.sh status
scripts/provider-switch.sh rollback  # one-command revert to the previous file
```

### 4. Watch it

* Member OTP: with Termii on and `sent:false`, the response stays generic (no code
  ever leaks) and an `audit_logs` entry `member.otp.delivery_failed` is written —
  query it to see delivery trouble at a glance.
* Notifications: the nightly 06:30 timer flushes queued messages; `POST
  /api/v1/notifications/dispatch` does it on demand and reports `sent`/`failed`.
* Virtual accounts: enable Monnify, then check a member's collection account in
  the portal; the payment webhook path is signature-checked and audited.

### 5. Sandbox → live

`MONNIFY_BASE_URL` selects the environment (`https://sandbox.monnify.com` vs
`https://api.monnify.com`). Re-run the preflight and the demo after switching
bases — `scripts/seed-demo.sh` walks the whole money loop and asserts a ₦0 trial
balance, which catches contract/credential mismatches immediately.
