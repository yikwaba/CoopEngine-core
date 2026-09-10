# Co-opEngine — Phase D Readiness Report

**Date:** 10 September 2026
**Status:** **Phase D tooling complete and rehearsed.** Only the real provider credentials are outstanding; deployment is a two-command procedure that has been proven end-to-end with dummy values.

---

## 1. What Phase D means now

Provider integration is no longer a development task — the production code paths
exist and are tested. What remains is *operational*: paste five values, validate,
flip a switch.

| Provider | Code path | Status |
| --- | --- | --- |
| **Termii** (member OTP SMS) | env-configurable base URL/channel/timeout, bounded timeout, graceful failure | wired · proven against mocks + live failure rehearsal |
| **Monnify** (virtual accounts, payment webhooks) | `POST /api/v1/auth/login` auth (verb bug fixed earlier), reserved accounts, signed webhook posting to savings | wired · proven against mocks |
| **SMTP** (notification email) | nodemailer, activates from `providers.env` | wired · dev adapter until credentials exist |

## 2. The tooling (all rehearsed)

| Script | Purpose | Rehearsal result |
| --- | --- | --- |
| `scripts/provider-set-key.sh` | hidden-prompt key entry: trims CR/whitespace from Windows pastes, validates shape, writes atomically to the root-only file, prints only a masked confirmation | ✅ values stored, only `dumm…6789` style masks shown |
| `scripts/provider-preflight.sh` | validates Termii balance + Monnify `POST /auth/login` (Basic header built in-process), optional test SMS; `--require` turns missing keys into a hard gate | ✅ skipped cleanly with no keys, **exit 2** with `--require`, **exit 1** on dummy credentials (proving real calls) |
| `scripts/provider-switch.sh` | `status` / `termii` / `monnify` / `both` / `off` / `rollback`; refuses to enable a provider with missing credentials (exit 3), atomic write, one backup, restart + `/health` check | ✅ refused without keys, allowed with keys, service stayed healthy, **rollback restored the previous file** |
| `scripts/providers.env.example` | committed template (no values) documenting every variable | ✅ |

## 3. Failure-path proof (live API, dummy Termii key)

| Probe | Result |
| --- | --- |
| `provider-switch.sh termii` with a dummy key | ✅ allowed (credentials present), API restarted, health OK |
| Member OTP with Termii on and a failing key | ✅ `{"sent":false,"provider":"termii"}` — **no `devCode`, no internal error detail** |
| Audit trail | ✅ `audit_logs: member.otp.delivery_failed · {"provider":"termii"}` (no member data, no code) |
| `provider-switch.sh off` | ✅ dev path restored: `{"sent":true,"devCode":"…","provider":"dev"}` |
| Member login using that dev code | ✅ token issued (end-to-end member auth over the live stack) |

A gap found during the rehearsal — no audit trail for OTP delivery failures — was
fixed in `member-auth.service.ts` and is now covered above.

## 4. Deployment runbook (the day the keys arrive)

```bash
cd /root/CoopEngine-core

# 1. store credentials (hidden prompts — never paste keys into a chat)
scripts/provider-set-key.sh TERMII_SENDER_ID
scripts/provider-set-key.sh TERMII_API_KEY
scripts/provider-set-key.sh MONNIFY_API_KEY
scripts/provider-set-key.sh MONNIFY_SECRET_KEY
scripts/provider-set-key.sh MONNIFY_CONTRACT_CODE
# optional, to have the preflight send one real SMS:
scripts/provider-set-key.sh TERMII_TEST_PHONE

# 2. validate, then switch
scripts/provider-preflight.sh --require     # exit 0 = safe to switch
scripts/provider-switch.sh both             # or termii / monnify separately
scripts/provider-switch.sh status

# 3. prove the money loop on the live stack
scripts/seed-demo.sh                        # asserts a ₦0 trial balance

# rollback at any point:
scripts/provider-switch.sh rollback
```

Estimated time with credentials in hand: **under 15 minutes**.

## 5. Current state of the live beta

* HTTPS live on the portal, member PWA and API (`*.169.58.196.141.nip.io`, Let's Encrypt)
* Providers **off** (dev mode) — the safe default until the keys exist
* 31 FORCE-RLS tables · 48 integration tests across 25 files · CI green
* Nightly timers armed: backup 02:17 · arrears 06:15 · notifications + contribution sweep 06:30
* `providers.env` deliberately contains **only** the two dev switches — no rehearsal values remain

## 6. Left after Phase D

1. **Credentials** into `providers.env` (five values, one operator, 15 minutes).
2. **One-month reconciliation gate** — keep local Postgres as the warm fallback until a full month reconciles at 0 mismatches, then retire it.
3. Optional hardening: fail2ban jail over Caddy access logs; offsite copies of the nightly dumps and the KYC `uploads/` directory.
