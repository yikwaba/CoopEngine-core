# Payments (virtual accounts) — operator notes

Collection rail: each cooperative can issue per-member **virtual (reserved)
accounts**; inbound bank transfers arrive as Monnify webhooks and are posted
straight onto the double-entry ledger.

## Modes

| `MONNIFY_PROVIDER` | Behaviour |
|---|---|
| `dev` (default) | Local accounts (`8xxxxxxxxx`, "Dev Bank") and local webhook posts. No outbound calls. Used by tests and local demos. |
| `monnify` | Real Monnify reserved accounts + real webhooks. Requires `MONNIFY_API_KEY`, `MONNIFY_SECRET_KEY`, `MONNIFY_CONTRACT_CODE` (base URL defaults to `https://sandbox.monnify.com`). Refuses to run without them. |

## Configuration (monnify mode)

1. Monnify dashboard → API keys: put `API_KEY`/`SECRET_KEY` (client secret) in
   the environment — the secret key is also used for webhook verification.
2. Register the webhook URL: `https://<host>/api/v1/payments/monnify/webhook`.
3. The service authenticates with Basic auth, requests a reserved account per
   member, and stores Monnify's account reference alongside ours.

## Webhook semantics

- **Verification**: SHA-512 of `secretKey + "|" + raw body` compared against
  the `monnify-signature` header (timing-safe string compare). The API boots
  with `bodyParser: false` and captures raw bytes via an express `json`
  verify hook, so the signature is over the exact received payload.
- **Idempotency**: keyed on `paymentReference` per organization. Re-deliveries
  are acknowledged (`200 { acknowledged: true }`) and never double-post.
- **Unknown accounts**: acknowledged with `acknowledged: false` and nothing is
  stored — the endpoint never reveals whether an account number exists.
- **Non-success statuses**: acknowledged but not posted.
- **Posting**: a verified successful payment auto-opens (if needed) the
  member's REGULAR-SAVINGS account and posts one balanced journal
  (`Dr 1000 Cash / Cr 2000 Member Savings Deposits`, member-linked,
  `PAYMENT_COLLECTION` source) with balance + projection updates in the same
  tenant transaction.

## Replay / recovery guidance

- Monnify retries are safe: replaying the same `paymentReference` hits the
  dedupe path.
- If a webhook is lost entirely, Monnify's transaction API or the bank
  statement can be used to reconstruct it — the `paymentReference` is the
  idempotency anchor; any single replay produces exactly one journal entry.
- Reconciliation safety net: `GET /reports/savings-reconciliation` compares
  every savings balance against the ledger; after any payment incident the
  report must show **0 mismatches**.

## Staff & member surfaces

- Staff: `GET/POST /payments/virtual-accounts`, `GET /payments/internal/
  notifications?limit=&offset=` (`X-Total-Count` header), portal
  "Collections" page.
- Member (self-service token): `GET /member/virtual-account` (their number +
  bank) and `GET /member/payments` (their funding history) — member PWA shows
  the account prominently.
