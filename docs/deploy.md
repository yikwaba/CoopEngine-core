# Co-opEngine — Deployment & operations guide

Local dev database (this VPS): PostgreSQL 16 at `127.0.0.1:5432`, role/db `coopengine`
(dev credentials live in `packages/db/drizzle.config.ts`, `.env.example`, and
`/root/coopengine/api.env` — never commit or echo them).

---

## 1. One-command full stack (local/VPS dev)

```bash
pnpm build                 # once (or set STACK_SKIP_BUILD=1 later)
./scripts/start-stack.sh   # loads /root/coopengine/api.env, starts:
                           #   API :3999 (+ /docs) · portal :3100 · member PWA :3200
```

Prereqs: Postgres running, migrations + RLS + seed applied:

```bash
export DATABASE_URL=postgres://coopengine:coopengine@127.0.0.1:5432/coopengine
cd packages/db && pnpm db:migrate && pnpm db:force-rls && pnpm db:seed
```

## 2. API as a systemd user service (long-running)

```bash
mkdir -p ~/.config/systemd/user
cp docs/systemd/coopengine-api.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now coopengine-api
systemctl --user status coopengine-api      # logs: journalctl --user -u coopengine-api -f
```

Rebuild + restart after a deploy:

```bash
cd /root/CoopEngine-core && pnpm build
systemctl --user restart coopengine-api
```

## 3. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | always | Postgres connection (prod: Supabase pooled URL) |
| `PORT` | no | API port (default 3000; dev 3999) |
| `NODE_ENV` | prod | `production` enables fail-fast secrets |
| `JWT_ACCESS_SECRET` | **prod** | ≥32 random chars; **boot fails without it in production** |
| `JWT_ACCESS_TTL_SECONDS` | no | default 900 |
| `REFRESH_TOKEN_TTL_DAYS` | no | default 30 |
| `CORS_ORIGINS` | no | comma list (defaults localhost:3100,3200) |
| `MEMBER_OTP_PROVIDER` | no | `dev` (returns codes, tests) or `termii` |
| `TERMII_API_KEY` | termii | Termii portal API key |
| `TERMII_SENDER_ID` | termii | approved sender/alphanumeric ID |
| `NEXT_PUBLIC_API_URL` | web apps | portal/PWA API base at build/run time |

Front-end builds: `apps/portal` & `apps/member-pwa` read `NEXT_PUBLIC_API_URL`
(defaults to `http://localhost:3999/api/v1`).

## 4. Production wiring checklist (Supabase + Termii)

1. **Supabase Postgres**: run migrations via `pnpm db:migrate` with the pooled
   `DATABASE_URL`; then `pnpm db:force-rls` (this enforces RLS on all 23 tenant
   tables and installs the balanced-journal trigger) and `pnpm db:seed` with a
   fresh SaaS-admin password (override in seed or rotate immediately).
2. **Non-superuser role**: RLS is only meaningful if the app role is
   `NOSUPERUSER` (CI does this automatically via `scripts/ci-init-db.mjs`; on
   Supabase the `postgres` role already is superuser — create an app role).
3. **Termii**: set `MEMBER_OTP_PROVIDER=termii` + keys; member rows need
   `phone` set or OTPs are not sent (response stays generic — no enumeration).
4. **CORS/JWT**: set `CORS_ORIGINS` to real portal/PWA origins and a strong
   `JWT_ACCESS_SECRET` (generate: `openssl rand -base64 48`).
5. **Serving**: run the API behind a reverse proxy (Caddy/Nginx) with TLS;
   portal/PWA can be served as static Next.js builds behind the same proxy.

## 5. Standing rotation checklist (from earlier arcs — still pending)

These credentials were pasted into chat or stored earlier and should be
rotated when convenient:

- GitHub fine-grained PATs in `~/.git-credentials` (Contents + Workflows R/W
  on CoopEngine-core) → generate new ones with the same scopes, update the
  file, revoke the old.
- Composio project/CLI keys.
- himalaya Gmail app password (Gmail account `yikwab.a@gmail.com`, read+draft
  only) → revoke in Google account settings, store new one via the
  `himalaya` config (never paste it into chat).
- Local dev secrets are **dev-only**: seeded admin password, dev JWT secret,
  and the local Postgres password — rotate before any shared deployment.

## 6. Verification baseline

- `pnpm typecheck` (5 packages) · `pnpm test` (unit) · `pnpm build` (5 packages)
- Integration: `pnpm --filter @coopengine/db test:integration` + API suite
  (`apps/api`, real PostgreSQL, `fileParallelism: false`)
- CI (GitHub Actions) runs quality + integration against a real Postgres 16
  service container with a NOSUPERUSER app role.
- E2E demo: `node scripts/demo.mjs` against a running API.


---

## Operations update — 2026-09-10

### Environment variables added since the first draft

| Variable | Where | Purpose |
| --- | --- | --- |
| `INTERNAL_CRON_TOKEN` | `api.env` (root-only) | Shared secret for the machine endpoints (`/api/v1/internal/notifications/dispatch`, `/api/v1/internal/savings/sweep`). Generated with `openssl rand -hex 24`. |
| `DOCUMENTS_DIR` | service env (default `/root/coopengine/uploads`) | On-disk root for the KYC document vault (per-tenant subfolders). Back this up with the database. |
| `DOCUMENTS_MAX_BYTES` | optional (default 5 MB) | Upload cap for member documents. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | `providers.env` | Switches the notification EMAIL channel from the dev adapter to real SMTP (nodemailer). Port 465 ⇒ implicit TLS. |
| `TERMII_BASE_URL` / `TERMII_CHANNEL` / `TERMII_TIMEOUT_MS` | `providers.env` | Termii SMS overrides (defaults: `https://api.ng.termii.com`, `generic`, 8000 ms). |
| `MONNIFY_BASE_URL` / `MONNIFY_TIMEOUT_MS` | `providers.env` | Monnify endpoint override (sandbox vs live) and request timeout. |
| `SEED_ADMIN_PASSWORD` | shell when reseeding | Overrides the seeded SaaS-admin password; the integration suite also reads it. |

`providers.env` is optional and loaded with `EnvironmentFile=-/root/coopengine/providers.env`.

### Nightly timers (systemd user units, installed and armed)

| Timer | Schedule | What it does |
| --- | --- | --- |
| `coopengine-backup.timer` | 02:17 | `pg_dump` as the local `postgres` superuser → `/var/lib/postgresql/backups` (7-dump retention). |
| `coopengine-arrears.timer` | 06:15 | Marks DISBURSED loans as DEFAULTED when any unpaid installment is 90+ days late (per tenant, RLS GUC set, audited). |
| `coopengine-notify.timer` | 06:30 | Sweeps due standing-contribution instructions (queues reminders) and flushes pending notifications (Termii SMS / SMTP email / dev adapter). |

Check with `XDG_RUNTIME_DIR=/run/user/0 systemctl --user list-timers | grep coopengine`.

### RLS lessons that matter in production

1. **Never rely on `SECURITY DEFINER` to bypass RLS.** A function owned by a role
   that is itself subject to FORCE RLS still sees nothing. Cron workers enumerate
   tenants through a narrow, `SELECT`-only `internal_scan` policy on
   `organizations` that only matches when the transaction-local flag
   `app.internal_scan = 'on'` is set (migration `0025`).
2. **Predicates must tolerate a blank GUC.** All tenant policies now use
   `nullif(current_setting('app.tenant_id', true), '')::uuid` so a missing or
   empty setting means "no rows" instead of
   `invalid input syntax for type uuid: ""` (migration `0024`).
3. **Custom migrations are the supported path** for raw SQL:
   `pnpm exec drizzle-kit generate --custom --name=...` then `pnpm db:migrate`.
   `db:force-rls` only enforces the RLS flag; it does not rewrite predicates.

### One-command demo tenant

```bash
scripts/seed-demo.sh            # against http://localhost:3999
API_BASE=https://api.example.com/api/v1 scripts/seed-demo.sh
```

Creates a fresh cooperative (unique slug) with members, deposits, share
purchases, a full loan lifecycle, a dividend run and the reconciliation +
trial-balance checks, then prints the logins to use in the portal and PWA.

---

## Phase E — TLS proxy and launch (executed 2026-09-10)

### Topology

```
Internet ──▶ Caddy (:80/:443, Let's Encrypt) ──▶ 127.0.0.1 services
   api.<host>     → API        :3999   (systemd user unit coopengine-api)
   app.<host>     → portal     :3100   (coopengine-portal)
   member.<host>  → member PWA :3200   (coopengine-pwa)
```

Units and the proxy config live in `docs/systemd/` and `docs/tls/Caddyfile`;
the installed copies are `/etc/caddy/Caddyfile` and `~/.config/systemd/user/`.

### Public hostnames

The beta runs on `nip.io` hostnames bound to this VPS address — real Let's
Encrypt certificates with no domain purchase, and a one-line change to swap in a
custom domain later (only the Caddyfile site addresses and `CORS_ORIGINS`):

| Role | URL |
| --- | --- |
| API (+ Swagger at `/docs`) | https://api.169.58.196.141.nip.io/api/v1 |
| Staff portal | https://app.169.58.196.141.nip.io |
| Member PWA | https://member.169.58.196.141.nip.io |

### Steps that were run

```bash
# 1. Caddy
apt-get install -y caddy            # official Cloudsmith repo
mkdir -p /var/log/caddy && chown -R caddy:caddy /var/log/caddy
install -m 644 docs/tls/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl restart caddy

# 2. Web apps as user services (linger is enabled, so they survive logout/reboot)
NEXT_PUBLIC_API_URL=https://api.169.58.196.141.nip.io/api/v1 pnpm --dir apps/portal build
NEXT_PUBLIC_API_URL=https://api.169.58.196.141.nip.io/api/v1 pnpm --dir apps/member-pwa build
systemctl --user enable --now coopengine-portal coopengine-pwa coopengine-api
```

`NEXT_PUBLIC_API_URL` is **inlined at build time** — rebuild the web apps after
changing the API hostname, then restart their units.

### Verified

* Let's Encrypt certificates issued for all three hosts (valid ~90 days, renewed
  automatically by Caddy) — verified with `openssl s_client`/`x509 -dates`
* `https://api…/health` → `{"status":"ok"}`; Swagger `/docs/` → 200
* All 8 portal routes and all member routes → **200** over HTTPS
* Security headers present: HSTS (1 year, includeSubDomains), `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`; `Server` stripped
* CORS preflight from the portal origin → **204**; real admin login over HTTPS → **200** with a token
* Plain HTTP → **308** redirect to HTTPS

### Remaining operational tasks

1. **Provider keys** (`providers.env`): Termii + Monnify live values; the SMS and
   payment paths are already wired and mock-proven.
2. **Custom domain** when you have one (optional): point DNS at this VPS, change the
   three site addresses in the Caddyfile + `CORS_ORIGINS`, rebuild the web apps.
3. **One-month gate**: keep local Postgres as a warm fallback until a full month of
   ledger operations reconciles at 0 mismatches, then retire it.
4. Optional hardening: a fail2ban jail over the Caddy access logs, and offsite
   copies of the nightly database dumps and `DOCUMENTS_DIR`.

---

## Hardening pass (executed 2026-09-10)

### 1. Brute-force protection for the API (`fail2ban`)

Caddy writes structured JSON access logs; a filter turns failed authentication
into bans without touching the application:

* `docs/tls/filter-caddy-coopengine-auth.conf` → `/etc/fail2ban/filter.d/`
* `docs/tls/jail.local` → `/etc/fail2ban/jail.local` (`[caddy-auth]` jail:
  `maxretry = 8`, `findtime = 10m`, `bantime = 2h`, action `iptables-multiport`
  on `http,https`)

The filter matches `"remote_ip":"<HOST>" … "uri":"/api/v1/auth/…" … "status":401|403|429`
and reads the epoch timestamp from the JSON `ts` field (`datepattern = "ts":{EPOCH}`).
The server's own public address is in `ignoreip` so self-checks can never lock the
box out.

Verified: 11 replayed failures produced a ban, an `f2b-caddy-auth` REJECT rule
appeared in iptables, and both the ban and the rule were removed cleanly
(`scripts/prove-caddy-jail.sh` pattern). Production jails: `sshd`, `caddy-auth`.

### 2. Encrypted offsite backups (`scripts/offsite-backup.sh`)

Nightly at **03:10** (`coopengine-offsite.timer`), after the 02:17 dump:

* stages the two newest dumps + the whole KYC `uploads/` tree with a manifest
* **encrypts with AES-256 (gpg symmetric)** before anything leaves the box
* writes a SHA-256 sidecar and **verifies the copy** at the destination
* prunes local archives, keeping the newest `KEEP` (default 14)
* logs every run to `/root/coopengine/logs/offsite-backup.log`

Destination is configuration, not code: set `OFFSITE_DIR=/mnt/backups` (mounted
volume, NFS, USB disk) and/or `OFFSITE_RCLONE=remote:path` in
`/root/coopengine/offsite.env`. Without `OFFSITE_DIR` it stages locally and says
so in the log.

**The passphrase lives at `/root/coopengine/offsite-passphrase` (mode 600) and is
the only way to restore an archive — copy it somewhere safe and offline.** An
archive is useless without it; that is the point.

Rehearsed end to end: encrypted archive produced, destination checksum matched,
archive decrypted and inspected (dumps + manifest intact).

### Restoring from an offsite archive

```bash
gpg --batch --decrypt --passphrase-file /root/coopengine/offsite-passphrase \
  coopengine-<stamp>.tar.gz.gpg > /tmp/restore.tar.gz
tar -xzf /tmp/restore.tar.gz -C /tmp/restore
# database
sudo -u postgres pg_restore -d coopengine_restore /tmp/restore/payload/database/coopengine_<stamp>.dump
# documents
rsync -a /tmp/restore/payload/uploads/ /root/coopengine/uploads/
```

### 3. Choosing the offsite destination

`OFFSITE_TARGET` in `/root/coopengine/offsite.env` accepts three forms:

| Form | Example | Notes |
| --- | --- | --- |
| mounted directory | `OFFSITE_TARGET="dir:/mnt/backups"` | NFS share, USB disk, SAN volume |
| rclone remote | `OFFSITE_TARGET="rclone:b2-remote:bucket/prefix"` | any of rclone's 70+ backends |
| bare path | `OFFSITE_TARGET="/mnt/backups"` | treated as a directory |

Explicit environment values win over the file, so an ad-hoc run can point
somewhere else (`OFFSITE_TARGET=… scripts/offsite-backup.sh`).

**Create the remote safely** — credentials are read from hidden prompts, written
only to a 600-mode `~/.config/rclone/rclone.conf`, then round-trip tested:

```bash
scripts/setup-offsite-remote.sh
#  → Backblaze B2 keyID + application key (hidden)
#  → verifies listing, creates the destination, uploads + reads back + deletes a test object
#  → optionally wraps the remote in rclone crypt and prints the OFFSITE_TARGET line
```

Recommended for Backblaze B2:

1. Create the bucket, then create an **application key scoped to that bucket only**
   (never the master key), with read/write access.
2. Prefer **plain B2 remote + the gpg layer** over an rclone `crypt` remote: the
   gpg archive is self-contained, so a restore needs only `gpg` plus the
   passphrase — no rclone config, no second secret. If you do use `crypt`, set
   `OFFSITE_ENCRYPT=0` so you are not double-encrypting (and remember the crypt
   config then becomes as critical as the passphrase).
3. Backblaze keeps file versions; add a **bucket lifecycle rule** (e.g. hide +
   delete versions older than 30 days) so the remote cannot grow without bound —
   the script already prunes local archives to `KEEP`.

Every run verifies what actually landed: a **remote hash** when the backend
reports one (B2 returns sha1/md5), otherwise a size comparison with the local
sha256. A configured-but-unreachable target **fails loudly** (non-zero exit, the
nightly unit records the failure) instead of quietly "succeeding".

### 4. Retention, lifecycle and supervision (added 2026-09-11)

**Retention is enforced in two places.** Local archives keep the newest `KEEP`
(default 14); the same count is enforced in the vault by remote pruning
(`OFFSITE_REMOTE_KEEP=0` makes the vault append-only). Rehearsed: a vault seeded
with 16 archives plus a new upload came back to exactly 14, newest preserved.

**Backblaze keeps versions**, so deleting an archive leaves hidden versions
behind. Apply a bucket lifecycle rule once to expire them:

```bash
scripts/setup-b2-lifecycle.sh --days 30          # noncurrent versions expire after 30 days
#   keeps the 5 newest noncurrent versions, aborts stale multipart uploads after 7 days
#   override the region endpoint with B2_ENDPOINT=… when the bucket is not in eu-central-003
```

The script reads the key from hidden prompts, stores nothing, uses a dedicated
`/root/.venvs/b2lifecycle` (boto3) and prints the resulting rule IDs.

**Supervision.** `scripts/backup-watchdog.sh` checks that the newest dump and
archive are younger than 26 h, that the offsite leg verified its upload when a
target is configured, that the offsite timer is still firing, and that existing
KYC uploads are inside the archive. It writes
`/root/coopengine/logs/backup-status.json` and is **silent when healthy**:

* systemd: `coopengine-watchdog.timer` (07:00) — the unit records a failure
* Hermes cron job *"CoopEngine backup watchdog"* (daily 07:00) — delivers a short
  alert block **only** when something is wrong, straight to the operator's chat

So a backup that stops running announces itself; silence means healthy.

Timers in full (all systemd user units, linger enabled):

| Time | Unit | Purpose |
| --- | --- | --- |
| 02:17 | `coopengine-backup` | local `pg_dump` (7-dump retention) |
| 03:10 | `coopengine-offsite` | encrypted archive → vault (+ remote pruning) |
| 06:15 | `coopengine-arrears` | loan arrears auto-default |
| 06:30 | `coopengine-notify` | contribution sweep + notification dispatch |
| 07:00 | `coopengine-watchdog` | backup health check (silent unless broken) |

### 5. Backblaze bucket settings (encryption and Object Lock)

Two bucket-level switches are worth a deliberate decision.

**Default encryption (SSE-B2) — leave it on.** Backblaze encrypts every object at
rest with provider-managed keys; it is transparent, costs nothing extra and needs
no key handling. It is *not* a substitute for the archive's own encryption: anyone
holding the application key can still read the files. The **gpg envelope plus the
passphrase is the confidentiality boundary**, and it is also what keeps an archive
restorable on any machine without Backblaze or rclone.

**Object Lock / Default Bucket Retention — recommended: Compliance, 7 days.**
Default Bucket Retention applies immutability automatically to every file
uploaded, so a stolen application key or a compromised server cannot delete the
backups. Two things to know before you switch it on:

* Object Lock **can be enabled on an existing bucket**, but once the mode and
  duration are saved they **cannot be changed** (1–3,000 days) — decide once.
* Retention must stay **shorter than `KEEP`**: the nightly job prunes the vault to
  the newest `KEEP` archives (14 by default, ≈ two weeks old), so a 7-day
  retention never blocks it. If retention is longer than `KEEP`, pruning is
  refused and the vault keeps growing.

Governance mode can be bypassed by a key with the bypass capability — it protects
against accidents and casual mistakes. **Compliance mode cannot be bypassed by
anyone, including the account owner, until it expires** — that is the mode for
ransomware resilience. Whichever you choose, raise `KEEP` (for example to 40) if
you set a longer retention.

The backup script is aware of this: when a deletion is refused it counts the
refusals and logs

```
WARNING: 3 old archive(s) could not be removed (Object Lock retention, or the key lacks delete rights)
WARNING: keep KEEP greater than the bucket's retention days, or the vault will keep growing
```

and still completes the run after verifying the upload (proven by an immutability
rehearsal, not assumed).

**Lifecycle rule.** B2 keeps file versions, so a deleted archive leaves hidden
versions behind. `scripts/setup-b2-lifecycle.sh --days 30` expires noncurrent
versions after 30 days — keep that comfortably above the retention period too.

### 6. Domain switchover (nip.io → real domain)

`scripts/switch-domain.sh <domain>` moves the stack to a real domain in one
command: it preflights DNS and the services, rewrites the Caddyfile (keeping the
nip.io names as aliases), updates `CORS_ORIGINS`, rebuilds portal + PWA against
the new API host, restarts everything, waits for certificate issuance and then
verifies the routes. `--dry-run` checks prerequisites only; `--revert` goes back.

**Two layers — do not confuse them:**

| Layer | Where | What lives there |
| --- | --- | --- |
| Registration + nameservers | the registrar (set at NiRA) | who owns the name, and which nameservers are authoritative |
| DNS records (A/TXT/…) | the nameservers — i.e. Cloudflare | `@`, `www`, `api`, `app`, `member` → the VPS |

If the domain is delegated to Cloudflare, **the registrar hosts no DNS zone** —
that is correct, not a fault. Records are created in Cloudflare with
**Proxy status: DNS only** so member and staff traffic goes straight to the VPS
(no third party inside the TLS path).

**A newly registered domain can stay NXDOMAIN at public resolvers** for up to the
parent zone's SOA minimum TTL (commonly an hour) because the earlier NXDOMAIN is
negatively cached. The registry is already correct in the meantime — verify with
RDAP rather than DNS:

```bash
curl -s -H 'accept: application/rdap+json' \
  https://rdap.nic.net.ng/domain/coopengine.com.ng | python3 -m json.tool | head -30
```

**Diagnostics from this VPS:** outbound port 53 to external resolvers is filtered
(`dig @1.1.1.1` returns nothing) and WHOIS on port 43 times out. Use
**DNS-over-HTTPS over 443** instead:

```bash
curl -s -H 'accept: application/dns-json' \
  'https://dns.google/resolve?name=api.coopengine.com.ng&type=A'
```

The portal/PWA bake `NEXT_PUBLIC_API_URL` in at **build** time, so a domain change
requires a rebuild — which `switch-domain.sh` does for you.
