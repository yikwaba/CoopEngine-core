#!/usr/bin/env bash
# Co-opEngine synthetic health monitor.
#
#   Silent when everything is healthy.  Speaks only when something changes.
#
#   Why: on 2026-09-29 a database credential rotation put the API into a
#   6-minute run of HTTP 500s and nothing noticed, because every existing
#   check asked "is the port open?" rather than "can a person actually
#   use this?".  This monitor logs in for real, and watches the recovery
#   chain end to end - app, API, sign-in, certificates, disk, WAL
#   archiving and the offsite copy.
#
#   Contract (consumed by a no-agent Hermes cron job):
#     - no output  -> healthy, stay quiet
#     - text       -> delivered to the operator verbatim
#     - exit 0     -> normal
#     - exit 1     -> the monitor itself is broken; must never fail silently
#
#   Test hook: HC_FORCE_FAIL=<check> makes that one check fail, so the
#   alerting path can be proven without breaking the real platform.

set -uo pipefail

STATE_DIR=/root/.coopengine-health
STATE_FILE="$STATE_DIR/state"
REALERT_AFTER=3600          # while still broken, remind at most hourly
LOCK="$STATE_DIR/.lock"

mkdir -p "$STATE_DIR"

# One monitor per host, so a slow tick cannot overlap the next.
if ! mkdir "$LOCK" 2>/dev/null; then
  # A stale lock (older than 10 minutes) means the last run died.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

APP=https://app.coopengine.com.ng
MEMBER=https://member.coopengine.com.ng
API=https://api.coopengine.com.ng
ADMIN_EMAIL=admin@coopengine.dev
PW_FILE=/root/coopengine/admin-password
API_ENV=/root/coopengine/api.env
RCLONE_REMOTE=b2-coopengine:coopengine-offsite-backups-ng

NOW=$(date +%s)
FAILS=()
DETAIL=()

add_fail() { FAILS+=("$1"); DETAIL+=("$2"); }

forced() { [ "${HC_FORCE_FAIL:-}" = "$1" ]; }

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null; }

# ---------------------------------------------------------------- 1. the three sites
for entry in "portal|$APP/" "member app|$MEMBER/" "api|$API/api/v1/health"; do
  name="${entry%%|*}"; url="${entry##*|}"
  if forced "$name"; then code=503; else code="$(http_code "$url")"; fi
  [ "$code" = "200" ] || add_fail "$name" "$name: HTTP $code (expected 200) - $url"
done

# ---------------------------------------------------------------- 2. a real sign-in
# The check that would have caught the credential bug: everything above can be
# 200 while authentication is completely broken.
if forced "sign-in"; then
  add_fail "sign-in" "sign-in: forced test failure"
elif [ -r "$PW_FILE" ]; then
  PW="$(tr -d '\r\n' < "$PW_FILE")"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
      -X POST "$API/api/v1/auth/login" \
      -H 'Content-Type: application/json' \
      -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PW\"}" 2>/dev/null)"
  unset PW
  case "$code" in
    200|201) : ;;
    *) add_fail "sign-in" "sign-in: HTTP $code - the sites answer but nobody can log in" ;;
  esac
else
  add_fail "sign-in" "sign-in: could not read the admin password file"
fi

# ---------------------------------------------------------------- 3. certificate expiry
for host in app.coopengine.com.ng member.coopengine.com.ng api.coopengine.com.ng; do
  expiry="$(echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null \
            | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [ -z "$expiry" ]; then
    add_fail "tls-$host" "tls: $host - could not read the certificate"
  else
    epoch="$(date -d "$expiry" +%s 2>/dev/null || echo 0)"
    days=$(( (epoch - NOW) / 86400 ))
    [ "$days" -lt 21 ] && add_fail "tls-$host" "tls: $host expires in $days days ($expiry)"
  fi
done

# ---------------------------------------------------------------- 4. disk
avail_pct="$(df -P / | awk 'NR==2 {gsub("%","",$5); print 100-$5}')"
[ "${avail_pct:-0}" -lt 12 ] && add_fail "disk" "disk: only ${avail_pct}% free on /"

# ---------------------------------------------------------------- 5. WAL archiving
# Judge archiving on real BACKLOG, not on wall-clock idleness: a quiet platform
# produces few segments, and "no segment in an hour" is not a fault when nothing
# was written.  What matters is segments waiting to go out, archiver failures,
# and how many bytes of WAL are not yet archived.
if forced "wal-archive"; then
  add_fail "wal-archive" "wal-archive: forced test failure"
else
  waiting="$(find /var/lib/postgresql/16/main/pg_wal -maxdepth 1 -name '*.ready' -mmin +10 2>/dev/null | wc -l)"
  [ "${waiting:-0}" -gt 0 ] && add_fail "wal-archive" \
    "wal-archive: $waiting segment(s) have been waiting over 10 min - the archiver has stalled"

  DBURL="$(grep -m1 '^DATABASE_URL=' "$API_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'')"
  if [ -z "$DBURL" ]; then
    add_fail "wal-archive" "wal-archive: DATABASE_URL not found in api.env"
  else
    stats="$(psql "$DBURL" -tAc "
      select failed_count, archived_count, coalesce(last_archived_wal,'none'),
             coalesce((pg_current_wal_lsn() - '0/0'::pg_lsn)
               - (('x'||substring(last_archived_wal,9,8))::bit(32)::bigint::numeric * 4294967296
                  + ('x'||substring(last_archived_wal,17,8))::bit(32)::bigint::numeric * 16777216), -1)::bigint
      from pg_stat_archiver" 2>&1)"
    unset DBURL
    # Never let a psql diagnostic reach the operator: a connection error can
    # serialise the connection string, and that carries the database password.
    stats="$(printf '%s' "$stats" | tr -d '\r' | head -1)"
    case "$stats" in
      ''|*[!0-9|]*) stats="" ;;
    esac
    if [ -z "$stats" ]; then
      add_fail "wal-archive" "wal-archive: could not read archiver status (see /var/log/postgresql)"
    else
      failed="$(echo "$stats" | cut -d'|' -f1)"
      count="$(echo "$stats" | cut -d'|' -f2)"
      behind="$(echo "$stats" | cut -d'|' -f4)"
      [ "${count:-0}" -lt 1 ] && add_fail "wal-archive" \
        "wal-archive: no segment has ever been archived - recovery has no starting point"
      [ "${failed:-1}" != "0" ] && add_fail "wal-archive" \
        "wal-archive: $failed segment(s) FAILED to archive - recovery is degrading"
      if [ "${behind:--1}" -gt 50331648 ]; then
        add_fail "wal-archive" \
          "wal-archive: $((behind / 1048576)) MB of WAL is not yet archived (expected under 48 MB)"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------- 6. offsite copy
# Compare the offsite copy against what exists LOCALLY right now: if the local
# archive holds a segment the offsite bucket does not have, and it has been
# sitting there, the ship timer is not doing its job.  This is the check that
# catches "the job runs and fails looks exactly like the job runs and succeeds".
if forced "offsite"; then
  add_fail "offsite" "offsite: forced test failure"
else
  newest_local="$(ls -t /var/lib/postgresql/wal-archive 2>/dev/null | head -1)"
  offsite_newest="$(rclone lsf "$RCLONE_REMOTE/wal" 2>/dev/null | sort | tail -1)"
  if [ -z "$offsite_newest" ]; then
    add_fail "offsite" "offsite: no WAL segments in the offsite bucket - the offsite leg is not running"
  elif [ -n "$newest_local" ] && [ "$offsite_newest" != "$newest_local" ]; then
    local_age=$(( NOW - $(stat -c %Y "/var/lib/postgresql/wal-archive/$newest_local" 2>/dev/null || echo "$NOW") ))
    if [ "$local_age" -gt 900 ]; then
      add_fail "offsite" "offsite: segment $newest_local has been archived locally for $((local_age / 60)) min but is not offsite (newest offsite: $offsite_newest)"
    fi
  fi

  newest_base="$(rclone lsl "$RCLONE_REMOTE/base" 2>/dev/null | grep -v backup_manifest | sort -k2,3 | tail -1)"
  if [ -z "$newest_base" ]; then
    add_fail "offsite-base" "offsite: no base backup in the offsite bucket"
  else
    ts="$(echo "$newest_base" | awk '{print $2" "$3}' | cut -d. -f1)"
    epoch="$(date -d "$ts" +%s 2>/dev/null || echo 0)"
    age=$(( (NOW - epoch) / 86400 ))
    [ "$age" -gt 8 ] && add_fail "offsite-base" "offsite: newest base backup is $age days old (weekly backup may not be running)"
  fi
fi

# ---------------------------------------------------------------- 7. services
for unit in coopengine-api coopengine-portal coopengine-pwa; do
  if forced "unit-$unit"; then
    add_fail "unit-$unit" "service: $unit forced test failure"
  else
    state="$(XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active "$unit.service" 2>/dev/null)"
    [ "$state" = "active" ] || add_fail "unit-$unit" "service: $unit is '${state:-unknown}' (expected active)"
  fi
done
[ "$(systemctl is-active caddy 2>/dev/null)" = "active" ] || add_fail "unit-caddy" "service: caddy is not active"

# ---------------------------------------------------------------- verdict
PREV_STATUS=ok
PREV_ALERT=0
if [ -r "$STATE_FILE" ]; then
  PREV_STATUS="$(cut -d' ' -f1 "$STATE_FILE" 2>/dev/null)"
  PREV_ALERT="$(cut -d' ' -f2 "$STATE_FILE" 2>/dev/null)"
fi
[ -n "$PREV_STATUS" ] || PREV_STATUS=ok
case "$PREV_ALERT" in ''|*[!0-9]*) PREV_ALERT=0 ;; esac

if [ "${#FAILS[@]}" -gt 0 ]; then
  STATUS=fail
  emit=no
  if [ "$PREV_STATUS" != "fail" ]; then
    emit=yes
    header="Co-opEngine: ${#FAILS[@]} check(s) FAILING"
  elif [ $(( NOW - PREV_ALERT )) -ge "$REALERT_AFTER" ]; then
    emit=yes
    header="Co-opEngine: still failing (${#FAILS[@]} check(s))"
  fi
  if [ "$emit" = yes ]; then
    echo "$header"
    echo
    for line in "${DETAIL[@]}"; do echo "- $line"; done
    echo
    echo "Checked: sites, real sign-in, TLS, disk, WAL archiving, offsite copy, services."
    echo "Live: $APP"
  fi
  ALERT_AT=$NOW
else
  STATUS=ok
  ALERT_AT=0
  if [ "$PREV_STATUS" = "fail" ]; then
    echo "Co-opEngine: recovered - all checks passing again."
    echo
    echo "Sites 200, sign-in works, TLS valid, disk $avail_pct% free, WAL archiving current, offsite current, all services active."
  fi
fi

printf '%s %s\n' "$STATUS" "$ALERT_AT" > "$STATE_FILE"
exit 0
