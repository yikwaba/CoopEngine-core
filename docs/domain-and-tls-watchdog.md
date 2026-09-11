# Domain and TLS expiry watchdog

Two failures take a working SaaS offline without anything else looking wrong:

1. **A TLS certificate that stops renewing.** Let's Encrypt renews at 30 days; if Caddy
   is down, or port 80 is blocked, renewal silently stops and the site dies on expiry day.
2. **A domain registration that lapses.** Everything keeps working until it does not — then
   every hostname, every email address and the whole brand goes dark.

`scripts/domain-watchdog.sh` watches both, plus the health of the certificate issuer and
whether the platform actually answers on the real domain.

## What it checks

| Check | Alert threshold |
|---|---|
| TLS certificate for every hostname (nip.io and, once live, the real domain) | warn ≤ 21 days, critical ≤ 7 days |
| Certificate unobtainable (Caddy down, port closed) | broken, immediately |
| Caddy service state (nothing renews while it is down) | broken |
| Domain registration expiry via RDAP | warn ≤ 60 days, critical ≤ 30 days |
| Fewer than two nameservers published | warn |
| Domain resolves somewhere other than this server | warn |
| Domain resolves to a proxy (Cloudflare) — TLS terminates before this server | warn, with the origin-certificate remedy |
| HTTPS on the real domain returns 5xx (e.g. Cloudflare 525) | broken |
| The backup watchdog last reported a problem | warn (cross-check) |

## Running it

```bash
scripts/domain-watchdog.sh            # full human report
scripts/domain-watchdog.sh --quiet    # silent when healthy (this is what cron runs)
scripts/domain-watchdog.sh --json     # machine-readable; also written to logs/domain-status.json
```

Rehearse the thresholds without waiting for real time to pass:

```bash
CERT_WARN_DAYS=999 CERT_CRIT_DAYS=998 scripts/domain-watchdog.sh --quiet
DOMAIN=some-other-domain.test scripts/domain-watchdog.sh --json
```

## Noise control

A watchdog that cries every day gets ignored. This one alerts when the **severity
changes**, then daily while *critical/broken*, and at most weekly while *warn*. Notes
(things worth knowing but not acting on, such as an un-activated domain) never alert.
The last severity and alert date live in `logs/.domain-watchdog-state`.

## Where it runs

* **Hermes cron job** — every 3 hours at :20, `no_agent`, silent unless there is news:
  this is the channel that reaches a human.
* **systemd timer** (`docs/systemd/coopengine-domain-watchdog.{service,timer}`, daily
  07:20) — writes the same report to the journal for local history.

## Notes on this host

* This VPS **filters outbound port 53 and WHOIS/43**, so DNS is queried over
  DNS-over-HTTPS and the domain via RDAP. RDAP is occasionally slow: a failed lookup is
  reported as a **note**, never as a false alarm — and the DNS/HTTPS checks are
  deliberately independent of it, because a domain that has stopped answering must never
  be missed because a registry API was busy.
* An NXDOMAIN DNS reply still contains an `Authority` SOA record with a `data` field, so
  liveness is decided by parsing `Status` and the `Answer` array — not by a substring
  match, which would treat a dead domain as alive.
