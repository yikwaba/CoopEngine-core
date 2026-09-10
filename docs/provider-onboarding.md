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
