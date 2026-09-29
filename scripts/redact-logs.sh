#!/usr/bin/env bash
# Test failures can serialise pg connection parameters — password included — into the run logs.
# Logs are readable by anything on this box, and they are exactly the artefact a support session
# would ship off-box, so secrets are stripped as soon as a run finishes.
set -uo pipefail
# NOTE: /tmp/va-*.log is deliberately excluded — it is the runner's own stdout target, still open
# when this runs, and rewriting an open file truncates the run's evidence (it did exactly that once).
for f in /tmp/spec-*.log /tmp/verify-*.log; do
  [ -f "$f" ] || continue
  sed -i -E \
    -e "s/(password: ')[^']*(')/\1[redacted]\2/g" \
    -e "s/(password=)[^ &\"']*/\1[redacted]/g" \
    -e "s#(postgres(ql)?://[^:]+:)[^@]*@#\1[redacted]@#g" \
    "$f"
done
