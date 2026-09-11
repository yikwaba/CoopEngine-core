# Email delivery (Brevo) — setup and operation

Co-opEngine sends notification emails through SMTP. The application code is already
wired: `apps/api/src/notifications/notifications.service.ts` switches from the
dev recorder to real delivery as soon as `SMTP_HOST` (plus `SMTP_USER` /
`SMTP_PASS`) appears in `/root/coopengine/providers.env`. Nothing else changes.

Chosen provider: **Brevo** (free tier, SMTP + API, easy domain authentication,
no card required to start).

---

## 1. What to create in Brevo

1. Sign up at brevo.com (free).
2. **Senders, Domains & Dedicated IPs → Domains → Add a domain** → `coopengine.com.ng`.
3. Brevo shows the DNS records to publish (see §2) and a **Brevo code** (a TXT
   record used to prove ownership).
4. **SMTP & API → SMTP tab → Generate a new SMTP key.** Note:
   - **SMTP server:** `smtp-relay.brevo.com`
   - **Port:** `587` (STARTTLS) — or `465` (SSL)
   - **Login:** your Brevo account email
   - **Password:** the generated SMTP key (shown once)

## 2. DNS records to publish in Cloudflare (DNS only / grey cloud)

Publish **exactly** what Brevo's panel displays — the DKIM values are generated
per domain. The shapes are:

| Purpose | Type | Name | Value |
|---|---|---|---|
| Ownership proof | TXT | `@` | `brevo-code:<hash from Brevo>` |
| SPF | TXT | `@` | `v=spf1 include:spf.brevo.com ~all` |
| DKIM (newer flow) | CNAME | `mail._domainkey` | `<value>.<region>.dkim.brevo.com` |
| DKIM (2nd CNAME) | CNAME | `mail2._domainkey` | `<value>.<region>.dkim.brevo.com` |
| DKIM (legacy flow) | TXT | `mail._domainkey` | `k=rsa; p=<key from Brevo>` |
| DMARC | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@coopengine.com.ng` |

Notes:
- **One SPF record per domain.** If you already have one, merge the include into
  it — a second SPF record breaks authentication entirely.
- **DKIM is what matters most.** On shared IPs Brevo's envelope sender stays on
  Brevo's domain, so SPF does not align with the `From:` address; DMARC passes on
  **DKIM alignment** alone. Get DKIM right first.
- Start DMARC at `p=none` (monitor only). Move to `quarantine` then `reject` once
  reports look clean — roughly 2–4 weeks of real traffic.
- Use **CNAME DKIM** if Brevo offers it: keys rotate automatically, unlike TXT.

Verify from the server (uses DNS-over-HTTPS, because this VPS filters port 53):

```bash
scripts/verify-email-dns.sh            # checks SPF, DKIM and DMARC for the domain
```

## 3. Configure the server

```bash
cd /root/CoopEngine-core
scripts/smtp-configure.sh              # hidden prompts; writes providers.env, restarts the API
scripts/smtp-configure.sh --status     # shows what is configured (never prints secrets)
scripts/smtp-configure.sh --test you@example.com   # sends a real test message
```

The script:
- writes `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
  into `/root/coopengine/providers.env` (mode 600, timestamped backup, atomic
  replace, strips Windows `\r` from pastes),
- restarts the API user service and waits for `/health`,
- never echoes the password, and never takes it on the command line (use
  `--key-file` if pasting at a prompt is awkward).

## 4. Operating notes

- **Never send directly from the VPS.** Port 25 is blocked by most hosts, there is
  no reverse DNS entry, and deliverability would be poor. Always relay via Brevo.
- The nightly dispatch (06:30, `coopengine-notify.timer`) picks the change up
  automatically; nothing needs restarting besides the API.
- Failures are recorded: a notification row is marked `FAILED` with the provider
  error, and member OTP delivery failures are audit-logged (provider name only).
- **Volume:** one 500-member cooperative ≈ 3,000–5,000 emails/month (monthly
  statements + weekly contribution reminders). Brevo's free tier (~300/day ≈
  9,000/month) covers the pilot and the first few cooperatives; past ~50,000/month
  migrate to Amazon SES (cheapest at volume) — a config change only, since the app
  speaks plain SMTP.
- **Human mailboxes** (`info@`, `support@`) are a different job: use Google
  Workspace or Zoho Mail. Do not bulk-send from them — provider throttles and
  complaint handling can suspend the mailbox.

## 5. If mail does not arrive

1. `scripts/smtp-configure.sh --status` — is SMTP configured?
2. `scripts/smtp-configure.sh --test your-address` — what does the SMTP server say?
3. `scripts/verify-email-dns.sh` — are SPF/DKIM/DMARC published and visible?
4. Check Brevo's dashboard for the send log and any domain-authentication warning.
5. If it lands in spam: DKIM alignment is usually the culprit, then DMARC policy,
   then sender reputation (Brevo's shared IP) — none of which is a code problem.
