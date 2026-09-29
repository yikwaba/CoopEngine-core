#!/usr/bin/env bash
# Test failures can serialise pg connection parameters — password included — into the run logs.
# Logs are readable by anything on this box, and they are exactly the artefact a support session
# would ship off-box, so secrets are stripped as soon as a run finishes.
set -uo pipefail
for f in /tmp/spec-*.log /tmp/verify-*.log /tmp/va-*.log; do
  [ -f "$f" ] || continue
  sed -i -E \
    -e "s/(password: ')[^']*(')/\1[redacted]\2/g" \
    -e "s/(password=)[^ &\"']*/\1[redacted]/g" \
    -e "s#(postgres(ql)?://[^:]+:)[^@]*@#\1[redacted]@#g" \
    "$f"
done
