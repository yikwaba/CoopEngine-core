# Backup and recovery (measured, not claimed)

PRD NFR-006 and master prompt §26 require documented, **tested** restore capability. This records what
exists, what was measured, and how it is proven.

## The layers

| Layer | What | Where | Frequency |
|---|---|---|---|
| Logical | `pg_dump` of the database | local + encrypted offsite archive | nightly 02:17 |
| Encrypted offsite | gpg-encrypted archive of dumps | Backblaze B2 `coopengine-offsite-backups-ng/offsite-leg`, Object Lock COMPLIANCE | nightly 03:10 |
| **Physical base backup** | `pg_basebackup -Ft -z` | local `/var/lib/postgresql/base-backups` + offsite `.../base` | **weekly, Sunday 01:40** |
| **Continuous WAL archiving** | `archive_command` → `/var/lib/postgresql/wal-archive`, shipped offsite | local + `.../wal` | **every WAL switch; `archive_timeout = 300s` forces one at least every 5 minutes** |

## Measured position

- **RPO ≤ 5 minutes** — `archive_timeout = 300` means at most five minutes of committed work can be
  lost, even on an idle server. Previously: 24 hours (nightly dump only), with `archive_mode = off`.
- **RTO** — the recovery drill measured **3 seconds** to redo, reach a consistent recovery state,
  promote and accept connections. That figure is *recovery from a locally staged base backup*; a true
  disaster recovery (fetch from Backblaze, decrypt, extract, replay) adds transfer time and has not
  been measured — it is the next drill to run, and it should be run to a fresh host, not the source.

## The drill (repeatable)

`/root/coopengine/p0-wal-drill.sh` performs a real point-in-time restore:

1. writes a marker row (`audit_logs.action = 'drill.point_in_time'`) into the live database and records the timestamp;
2. forces a WAL switch and waits for the segment to reach the archive;
3. extracts a base backup into a scratch data directory. **Note:** `pg_basebackup` in tar format
   deliberately omits `postgresql.conf`, `pg_hba.conf` and `pg_ident.conf`, so the drill supplies a
   minimal config plus `recovery.signal`;
4. replays WAL with `recovery_target_time` set to the marker's timestamp and promotes;
5. asserts the marker is present and the ledger still balances in the restored copy;
6. tears the scratch cluster down — the live cluster is never modified.

Result of the recorded run (`/root/coopengine/recovery-drill-20260929-1702.log`): recovery log shows
`recovery stopping before commit of transaction …, time 2026-09-29 17:02:26.64122+00`; the marker was
recovered; `sum(debit) = sum(credit)` held in the restored copy.

## Failure visibility

- Backup watchdog (daily 07:00): decrypts and verifies the newest offsite archive.
- WAL shipping runs every 5 minutes; `pg_stat_archiver.failed_count` is the signal to watch, and the
  local archive directory holds segments until they are copied offsite.

## Gaps, stated plainly

1. Full disaster recovery to a **fresh host** has not been drilled (transfer + decrypt + restore).
2. The WAL archive is not independently pruned — retention is handled by the Object Lock on the
   offsite bucket, and locally by the weekly base-backup rotation.
3. There is still no off-host automation that *invents* the recovery host; recovery is run by hand
   with the script above.
