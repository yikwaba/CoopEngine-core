#!/usr/bin/env bash
# Co-opEngine backup watchdog.
#
# Silent when everything is healthy (so it can drive a no-noise alert cron);
# prints a short alert block and exits non-zero when something is wrong.
#
# Checks:
#   1. the newest database dump is younger than 26 h
#   2. the newest encrypted archive is younger than 26 h
#   3. when an offsite target is configured, the last run's offsite leg succeeded
#   4. the last offsite run is younger than 26 h (timer still firing)
#   5. the archive contains the KYC uploads tree when uploads exist
#
# Output: a status JSON at /root/coopengine/logs/backup-status.json
set -uo pipefail

DUMP_DIR="${DUMP_DIR:-/var/lib/postgresql/backups}"
ARCHIVE_DIR="${ARCHIVE_DIR:-/root/coopengine/backup-archives}"
UPLOADS_DIR="${UPLOADS_DIR:-/root/coopengine/uploads}"
LOG="${LOG:-/root/coopengine/logs/offsite-backup.log}"
STATUS_JSON="${STATUS_JSON:-/root/coopengine/logs/backup-status.json}"
ENV_FILE="${OFFSITE_ENV_FILE:-/root/coopengine/offsite.env}"
# The archive is GPG-encrypted, so verifying its contents needs the same passphrase
# file the offsite script used. Without it the check cannot see inside at all.
PASS_FILE="${PASSPHRASE_FILE:-/root/coopengine/offsite-passphrase}"
MAX_AGE_H=26

problems=()
notes=()

now=$(date +%s)
age_h() { # age in hours of a file, or 999999 when missing
  [ -e "$1" ] || { echo 999999; return; }
  echo $(( (now - $(stat -c %Y "$1")) / 3600 ))
}

# 1. newest dump
DUMP="$(ls -1t "$DUMP_DIR"/*.dump 2>/dev/null | head -1 || true)"
if [ -z "$DUMP" ]; then problems+=("no database dump found in $DUMP_DIR"); else
  d_age=$(age_h "$DUMP"); notes+=("dump: $(basename "$DUMP") (${d_age}h old)")
  [ "$d_age" -gt "$MAX_AGE_H" ] && problems+=("newest database dump is ${d_age}h old (> ${MAX_AGE_H}h)")
fi

# 2. newest encrypted archive
ARCH="$(ls -1t "$ARCHIVE_DIR"/*.gpg "$ARCHIVE_DIR"/*.tar.gz 2>/dev/null | head -1 || true)"
if [ -z "$ARCH" ]; then problems+=("no archive found in $ARCHIVE_DIR"); else
  a_age=$(age_h "$ARCH"); notes+=("archive: $(basename "$ARCH") (${a_age}h old)")
  [ "$a_age" -gt "$MAX_AGE_H" ] && problems+=("newest archive is ${a_age}h old (> ${MAX_AGE_H}h)")
fi

# 3+4. the offsite leg
target=""
if [ -f "$ENV_FILE" ]; then
  target="$(grep -E '^[[:space:]]*OFFSITE_TARGET=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'" || true)"
fi
# an explicit environment value wins (same precedence as the backup script)
target="${OFFSITE_TARGET:-$target}"

if [ -f "$LOG" ]; then
  LAST_RUN_LINE="$(grep -n '=== offsite backup run' "$LOG" | tail -1 | cut -d: -f1 || true)"
  if [ -n "$LAST_RUN_LINE" ]; then
    TAIL="$(tail -n +"$LAST_RUN_LINE" "$LOG")"
    if printf '%s' "$TAIL" | grep -q 'ERROR'; then
      problems+=("last offsite run logged an ERROR: $(printf '%s' "$TAIL" | grep 'ERROR' | tail -1 | cut -c1-160)")
    fi
    if [ -n "$target" ]; then
      printf '%s' "$TAIL" | grep -q 'offsite leg: uploaded and verified' \
        || problems+=("offsite target is configured ($target) but the last run did not verify an upload")
    else
      notes+=("offsite target: NOT configured (archives staged locally only)")
    fi
    last_stamp="$(printf '%s' "$TAIL" | grep '=== offsite backup run' | tail -1 | sed -E 's/.*run ([0-9]{8}T[0-9]{6})Z.*/\1/')"
    if [ -n "$last_stamp" ]; then
      run_epoch=$(date -u -d "$(printf '%s' "$last_stamp" | sed -E 's/([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})/\1-\2-\3 \4:\5:\6/')" +%s 2>/dev/null || echo "$now")
      run_age=$(( (now - run_epoch) / 3600 ))
      notes+=("last offsite run: ${run_age}h ago")
      [ "$run_age" -gt "$MAX_AGE_H" ] && problems+=("the offsite timer has not run for ${run_age}h")
    fi
  else
    problems+=("offsite log has no completed run recorded")
  fi
else
  problems+=("offsite log missing: $LOG")
fi

# 5. KYC uploads coverage
if [ -d "$UPLOADS_DIR" ] && [ -n "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ]; then
  if [ -n "$ARCH" ]; then
    ARCH_LIST="$(mktemp)"
    READABLE=0
    if tar -tzf "$ARCH" > "$ARCH_LIST" 2>/dev/null; then
      READABLE=1                                    # plain tar.gz (encryption disabled)
    elif [ ! -f "$PASS_FILE" ]; then
      problems+=("cannot verify the archive contents: passphrase file $PASS_FILE is missing")
    elif gpg --batch --quiet --passphrase-file "$PASS_FILE" --decrypt "$ARCH" 2>/dev/null \
         | tar -tzf - > "$ARCH_LIST" 2>/dev/null && [ -s "$ARCH_LIST" ]; then
      READABLE=1                                    # decrypted and listed
    else
      problems+=("cannot read the archive to verify coverage (decryption failed) — check $PASS_FILE")
    fi
    if [ "$READABLE" -eq 1 ]; then
      if grep -q '^payload/uploads/' "$ARCH_LIST"; then
        notes+=("uploads: $(grep -c '^payload/uploads/' "$ARCH_LIST") entries included in the archive")
      else
        problems+=("KYC uploads exist but were not found inside the archive")
      fi
    fi
    rm -f "$ARCH_LIST"
  fi
else
  notes+=("uploads: none yet")
fi

mkdir -p "$(dirname "$STATUS_JSON")"
PROB_TMP="$(mktemp)"
if [ "${#problems[@]}" -gt 0 ]; then printf '%s\n' "${problems[@]}" > "$PROB_TMP"; else : > "$PROB_TMP"; fi
python3 - "$STATUS_JSON" "$PROB_TMP" <<'JSONGEN'
import datetime, json, pathlib, sys
status_file, prob_file = sys.argv[1], sys.argv[2]
problems = [line.strip() for line in pathlib.Path(prob_file).read_text().splitlines() if line.strip()]
pathlib.Path(status_file).write_text(json.dumps({
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "healthy": not problems,
    "problems": problems,
}, indent=2) + "\n")
JSONGEN
rm -f "$PROB_TMP"

if [ "${#problems[@]}" -gt 0 ]; then
  echo "⚠️ Co-opEngine backup check failed ($(date -u +%Y-%m-%dT%H:%MZ))"
  for p in "${problems[@]}"; do echo "• $p"; done
  for n in "${notes[@]}"; do echo "· $n"; done
  echo "log: $LOG"
  exit 1
fi

# healthy → stay quiet (a no-noise alert channel depends on this)
if [ "${WATCHDOG_VERBOSE:-0}" = "1" ]; then
  echo "backup check OK"
  for n in "${notes[@]}"; do echo "· $n"; done
fi
exit 0
