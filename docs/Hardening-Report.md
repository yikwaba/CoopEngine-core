# Co-opEngine — Operations Hardening Report

**Date:** 10 September 2026
**Scope:** brute-force protection for the public API, and encrypted offsite backups of the database and member documents.

---

## 1. Brute-force protection (`fail2ban` over Caddy logs)

Caddy already writes structured JSON access logs with security headers. A filter
turns failed authentication into network bans — no application changes, no extra
attack surface.

| Setting | Value |
| --- | --- |
| Filter | `caddy-coopengine-auth` (reads `"remote_ip"`, `"uri"`, `"status"`; timestamp from the JSON `ts` field via `{EPOCH}`) |
| Match | `401`, `403`, `429` on any `/api/v1/auth/*` route |
| Jail `caddy-auth` | `maxretry = 8` · `findtime = 10m` · `bantime = 2h` · `iptables-multiport` on `http,https` |
| Self-protection | the server's own public address is in `ignoreip`, so health checks and probes can never lock the box out |

**Verified:** a replay of eleven failed logins produced a ban, an
`f2b-caddy-auth` REJECT rule appeared in iptables, and both the ban and its rule
were removed cleanly with **no residual rules**. Production jails now:
`sshd`, `caddy-auth`.

## 2. Encrypted offsite backups

The nightly 02:17 database dump protected *this machine*. Now the data also
leaves the machine — **encrypted** — every night at **03:10**.

What each run does (`scripts/offsite-backup.sh`, unit `coopengine-offsite`):

1. stages the **two newest dumps** plus the whole **KYC `uploads/`** tree, with a
   human-readable `MANIFEST.txt`
2. encrypts the archive with **AES-256** (gpg symmetric) *before* it leaves the box
3. writes a **SHA-256 sidecar** and **verifies the copy at the destination**
4. copies offsite when `OFFSITE_DIR` (mounted volume / NFS / USB) or
   `OFFSITE_RCLONE` is configured in `/root/coopengine/offsite.env`
5. prunes older local archives, keeping the newest 14
6. logs every run to `/root/coopengine/logs/offsite-backup.log`

**Rehearsal (real execution):** encrypted archive produced (164 KB), destination
checksum matched, archive **decrypted and inspected** — two dumps and the
manifest intact; the systemd unit itself was then run and reported
`Result=success`.

> 🔑 **The passphrase at `/root/coopengine/offsite-passphrase` (mode 600) is the
> only way to restore an archive.** Copy it somewhere safe and offline. Losing it
> means losing the offsite copies — that is the price of encryption, and the
> reason it is stored separately from the archives.

A restore recipe (decrypt → extract → `pg_restore` → `rsync` the uploads) is in
`docs/deploy.md`.

## 3. Current operating picture

| Layer | State |
| --- | --- |
| Public HTTPS (portal · PWA · API) | ✅ live, Let's Encrypt, HSTS + security headers |
| Services | ✅ `coopengine-api` · `coopengine-portal` · `coopengine-pwa` (user units, linger on) |
| Proxy / firewall | ✅ Caddy (`:80/:443`) + fail2ban jails `sshd`, `caddy-auth` |
| Nightly timers | ✅ backup 02:17 · **offsite 03:10** · arrears 06:15 · notifications + contribution sweep 06:30 |
| Data protection | ✅ 31 FORCE-RLS tables · local + encrypted offsite backups · restore drill documented |
| Quality gates | ✅ 48 integration tests across 25 files · CI green on every push |

## 4. Suggested next steps (all optional)

1. **Point the offsite leg at real remote storage** — one line in
   `offsite.env` (`OFFSITE_DIR=/mnt/backups` or `OFFSITE_RCLONE=…`).
2. **Offline copy of the passphrase** — print it, or store it in a password
   manager away from this server.
3. **Alerting** — the logs are already structured; a small watchdog could email
   or SMS (the notification centre is ready) when a backup run exits non-zero.
4. **Provider keys** — the last functional gap; the switch is rehearsed and takes
   about fifteen minutes (`docs/provider-onboarding.md`).
