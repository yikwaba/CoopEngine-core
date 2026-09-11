#!/usr/bin/env bash
# Verify the email DNS records for Brevo (SPF, DKIM, DMARC) via DNS-over-HTTPS.
#
#   scripts/verify-email-dns.sh [domain]      # default: coopengine.com.ng
#
# This VPS filters outbound port 53, so plain `dig` to external resolvers fails;
# DoH over 443 is the reliable path.
set -uo pipefail
DOMAIN="${1:-coopengine.com.ng}"

python3 - "$DOMAIN" <<'PYEOF'
import json
import sys
import urllib.parse
import urllib.request

domain = sys.argv[1]
DOH = "https://dns.google/resolve?"


def doh(name, rtype):
    url = DOH + urllib.parse.urlencode({"name": name, "type": rtype})
    try:
        req = urllib.request.Request(url, headers={"accept": "application/dns-json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except Exception as e:  # noqa: BLE001
        return {"Status": -1, "error": str(e)}


def answers(name, rtype):
    d = doh(name, rtype)
    return [(a.get("type"), a.get("data", "")) for a in d.get("Answer", [])], d.get("Status", -1)


problems = []
print("domain:", domain)
print()

# --- SPF ---------------------------------------------------------------------
spf, status = answers(domain, "TXT")
spf_records = [v.strip('"') for (_t, v) in spf if "v=spf1" in v]
print("SPF (TXT @)")
if not spf_records:
    print("  MISSING - no SPF record found (status=%s)" % status)
    problems.append("SPF missing")
else:
    for rec in spf_records:
        print("  found :", rec)
    if len(spf_records) > 1:
        print("  PROBLEM: more than one SPF record - merge them into one")
        problems.append("multiple SPF records")
    if any("include:spf.brevo.com" in r for r in spf_records):
        print("  ok    : includes spf.brevo.com")
    else:
        print("  PROBLEM: does not include spf.brevo.com")
        problems.append("SPF missing Brevo include")
print()

# --- DKIM --------------------------------------------------------------------
print("DKIM")
dkim_found = False
for name in ("mail._domainkey." + domain, "mail2._domainkey." + domain):
    txt, st = answers(name, "TXT")
    cn, _ = answers(name, "CNAME")
    if txt:
        for (_t, v) in txt:
            short = v.strip('"')
            print("  ok    : TXT %s -> %s" % (name, short[:60] + ("..." if len(short) > 60 else "")))
        dkim_found = True
    elif cn:
        for (_t, v) in cn:
            print("  ok    : CNAME %s -> %s" % (name, v))
        dkim_found = True
    else:
        print("  none  : %s (status=%s)" % (name, st))
if not dkim_found:
    problems.append("DKIM missing (Brevo signs with your domain; DMARC relies on it)")
print()

# --- Brevo ownership code ----------------------------------------------------
code, _ = answers(domain, "TXT")
brevo_codes = [v.strip('"') for (_t, v) in code if "brevo-code" in v]
print("Brevo domain code")
print("  " + (brevo_codes[0] if brevo_codes else "not found (optional once DKIM verifies)"))
print()

# --- DMARC -------------------------------------------------------------------
dmarc, st = answers("_dmarc." + domain, "TXT")
dmarc_records = [v.strip('"') for (_t, v) in dmarc if "v=DMARC1" in v]
print("DMARC (TXT _dmarc)")
if dmarc_records:
    for rec in dmarc_records:
        print("  found :", rec)
    if "p=none" in dmarc_records[0]:
        print("  note  : p=none is monitor-only. Move to quarantine/reject once reports look clean.")
else:
    print("  MISSING (status=%s) - recommended: v=DMARC1; p=none; rua=mailto:dmarc@%s" % (st, domain))
    problems.append("DMARC missing")
print()

# --- verdict -----------------------------------------------------------------
if problems:
    print("VERDICT: not ready yet")
    for p in problems:
        print("  -", p)
    print()
    print("Publish the records exactly as Brevo's panel shows them, then re-run this check.")
    sys.exit(1)
print("VERDICT: all email DNS records look correct")
PYEOF
