# Monitoring and alerting

## Why this exists

On 2026-09-29 a database credential rotation left the API returning HTTP 500 for
about six minutes. Every check that existed asked *"is the port open?"*, and every
port was open. Nothing noticed. The fault was found by a human who happened to
look.

Availability of a socket is not availability of a service. This monitor signs in
as a real user, and watches the recovery chain as well as the front door.

## What it checks, every five minutes

| Check | Fails when |
|---|---|
| Portal / member PWA / API | HTTP status is not 200 |
| **Real sign-in** | `POST /auth/login` does not return 200/201 — the sites are up but nobody can log in |
| TLS expiry (all three hosts) | Under 21 days remaining |
| Disk | Under 12% free on `/` |
| WAL archiving | Segments waiting over 10 min, any failed archive, or more than 48 MB of WAL not yet archived |
| Offsite copy | A segment has been archived locally for over 15 min and is not in Backblaze; no offsite copy; base backup older than 8 days |
| Services | `coopengine-api`, `coopengine-portal`, `coopengine-pwa`, `caddy` not active |

## Design rules

**Silent when healthy.** It produces output only on a change of state: a new
failure, one hourly reminder while still failing, or a recovery notice. A monitor
that repeats itself is a monitor the operator learns to ignore.

**Judged on backlog, not on the clock.** Archiving is measured by segments
waiting to go out and by unarchived bytes — not by "how long since the last
segment". A completely idle platform produces no WAL and has nothing at risk;
alerting on that would be a false alarm. The first version of this script got
exactly that wrong and was corrected within the hour.

**A broken monitor must not fail silently.** `exit 0` always; the text is the
signal. A missing credential or an unreadable file is itself reported as a failure.

**One run at a time.** A lock directory prevents a slow tick overlapping the next.

**No credential can reach the operator.** The sign-in password is read from file
and passed to curl without ever being echoed; psql output is shape-validated, so a
connection diagnostic (which can serialise the connection string) is discarded
rather than delivered.

## Where it lives

- Canonical source: `scripts/coopengine-health.sh`
- Deployed copy: `~/.hermes/scripts/coopengine-health.sh`
- Scheduled as a Hermes cron job, every five minutes, script-only (no agent, no tokens)
- State: `/root/.coopengine-health/state` — `ok <epoch>` or `fail <epoch-of-last-alert>`

## Testing it

```bash
HC_FORCE_FAIL=portal bash ~/.hermes/scripts/coopengine-health.sh   # inject a failure
rm -rf /root/.coopengine-health                                     # reset state
```

Expected behaviour: healthy run is silent; a new failure alerts; the same failure
repeating is silent; returning to healthy announces recovery.

## Known limits

- Alerts reach the operator through Telegram only. If the messaging path itself is
  down, failures are silent — an external heartbeat is still owed.
- It runs on the same host it watches. If the host dies, nothing alerts.
- There is no alert on *performance* degradation, only on hard failures.
