# Termii go-live (SMS for login codes and notifications)

Everything on our side is built and tested. What remains is the Termii account itself —
the values only you can obtain. This document is the whole path, in order.

## What you need (and where each one lives)

| # | What | Where | Time |
|---|---|---|---|
| 1 | **Termii account** | termii.com → sign up with your business email | ~10 minutes |
| 2 | **Sender ID approved** (`COOPENG`) | Dashboard → **Sender ID** → request a new one | **hours to 2 days** (carrier approval) — start this first |
| 3 | **API key** | Dashboard → **API Keys** (use the live key) | instant |
| 4 | **Wallet credit** | Dashboard → **Wallet / Billing** → fund (naira) | instant |

### When you request the sender ID
- **Type:** Transactional (this is what carries login codes and account alerts; promotional
  traffic is blocked for numbers on the DND register — transactional is not).
- **Sender ID:** `COOPENG` (letters/numbers only, 11 characters max).
- **Use case, if a form asks:**
  > One-time login codes and transaction alerts (contributions, loan repayments, dividends)
  > sent to members of cooperative societies on our platform, coopengine.com.ng.
- **Sample message:** `COOPENG: Your login code is 483920. It expires in 10 minutes.`

Until it is approved, messages are rejected or fall back to Termii's default sender, so
approval is the real gate — everything else can be ready in advance.

## Going live (one command)

Write the values into a file **on the server** (never in chat), then run the go-live script:

```bash
nano /root/termii.key
```
```
line 1: your Termii API key
line 2: COOPENG
line 3: your own phone number, e.g. 08031234567   (optional — enables the real test SMS)
```
`Ctrl+O`, `Enter`, `Ctrl+X`, then:

```bash
chmod 600 /root/termii.key
cd /root/CoopEngine-core && scripts/termii-onboard.sh --key-file=/root/termii.key
```

That single command:

1. writes the credentials to the root-only `providers.env` (atomic, backed up, only masked
   values printed) and shreds the key file;
2. runs the preflight — it prints the wallet balance and **sends a real SMS to your number**;
3. switches OTP and notification SMS to Termii;
4. verifies end to end: a member code request must come back **without the code** (it goes to
   the phone) and report provider `termii`;
5. **rolls back automatically** if any of that fails — a half-switched provider is never left
   behind. If it stops, the platform is still exactly as it was.

## What we verify afterwards

| Check | Expected |
|---|---|
| Preflight test SMS | arrives on your handset, message id returned |
| Wallet | balance shown; a warning if it is low |
| Member login | code arrives by SMS; **the API no longer returns the code** (the security milestone) |
| Notification dispatch | records reach `SENT` with a Termii message id |
| Bad number | audited as `member.otp.delivery_failed`, the member sees a clean error |

## Running it without surprises

- **Rollback at any time:** `scripts/provider-switch.sh rollback` (or `off` to return to dev).
- **Check state:** `scripts/provider-switch.sh status` and `GET /health/providers`.
- **Monitoring:** the SMS watchdog runs every 4 hours and stays **silent unless** the wallet is
  nearly empty, login codes start failing to deliver, notification failures exceed a fifth of
  sends, or SMS is switched on without credentials. It alerts at most once a day for a
  persistent problem.
- **Cost:** billed per 160-character part. The *Message wording* screen shows a part count next
  to the preview so a cooperative can see when a message will cost two or three times as much.

## Known limits

- **One sender ID per Termii account** — every cooperative you onboard sends as `COOPENG`
  unless you later provision separate Termii sub-accounts for per-cooperative branding.
- **Codes are 6 digits with a 10-minute life**, and login is rate-limited to 5 failed attempts
  per 15 minutes; Termii's own per-second limits also apply.
- **Delivery reports** from the carriers are not yet pulled back into the platform; undelivered
  codes surface through the audit log and the watchdog instead.
