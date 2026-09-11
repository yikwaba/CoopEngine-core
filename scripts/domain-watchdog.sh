#!/usr/bin/env bash
# Domain + TLS expiry watchdog for Co-opEngine.
#
# Watches the two silent killers: a TLS certificate that quietly fails to renew,
# and a domain registration that lapses. Both take a working SaaS offline while
# everything else looks healthy.
#
#   scripts/domain-watchdog.sh            # human report
#   scripts/domain-watchdog.sh --quiet    # silent when healthy (cron mode)
#   scripts/domain-watchdog.sh --json     # machine-readable
#
# Exit code: 0 on success (healthy, or an alert was printed). Non-zero only when
# the script itself could not run — that way the cron job delivers the alert text
# once instead of an alert plus an error.
#
# Thresholds (override for rehearsals):
#   CERT_WARN_DAYS=21  CERT_CRIT_DAYS=7  DOMAIN_WARN_DAYS=60  DOMAIN_CRIT_DAYS=30
set -uo pipefail

REPO=/root/CoopEngine-core
LOG_DIR=/root/coopengine/logs
STATE="$LOG_DIR/.domain-watchdog-state"
mkdir -p "$LOG_DIR"

CERT_WARN_DAYS="${CERT_WARN_DAYS:-21}"
CERT_CRIT_DAYS="${CERT_CRIT_DAYS:-7}"
DOMAIN_WARN_DAYS="${DOMAIN_WARN_DAYS:-60}"
DOMAIN_CRIT_DAYS="${DOMAIN_CRIT_DAYS:-30}"
DOMAIN="${DOMAIN:-coopengine.com.ng}"
NIPIO_IP="${NIPIO_IP:-169.58.196.141}"

MODE="report"
case "${1:-}" in
  --quiet) MODE="quiet" ;;
  --json) MODE="json" ;;
esac

# Resolve A records properly: an NXDOMAIN reply still contains an Authority SOA
# with a "data" field, so a substring test would treat a dead domain as live.
a_records() {
  curl -s --max-time 10 "https://dns.google/resolve?name=$1&type=A" 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("")
    raise SystemExit
if d.get("Status") == 0:
    print(" ".join(a.get("data", "") for a in d.get("Answer", []) if a.get("type") == 1))
else:
    print("")
'
}

HOSTS=("api.${NIPIO_IP}.nip.io" "app.${NIPIO_IP}.nip.io" "member.${NIPIO_IP}.nip.io")
# Watch the real domain as soon as it answers (it is the one that matters).
DOMAIN_A="$(a_records "$DOMAIN")"
DOMAIN_LIVE=0
if [ -n "$DOMAIN_A" ]; then
  DOMAIN_LIVE=1
  HOSTS+=("${DOMAIN}" "api.${DOMAIN}" "app.${DOMAIN}" "member.${DOMAIN}")
fi

cert_days() { # cert_days <host> -> days remaining, or -1 when unobtainable
  local host="$1" notafter exp
  notafter=$(echo | timeout 15 openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  [ -n "$notafter" ] || { echo -1; return; }
  exp=$(date -d "$notafter" +%s 2>/dev/null || echo 0)
  [ "$exp" -gt 0 ] || { echo -1; return; }
  echo $(( (exp - $(date +%s)) / 86400 ))
}

severity_rank() { case "$1" in ok) echo 0 ;; note) echo 1 ;; warn) echo 2 ;; critical) echo 3 ;; broken) echo 4 ;; *) echo 0 ;; esac; }

WORST="ok"
PROBLEMS=()
NOTES=()
bump() { # bump <severity> <message>
  local sev="$1" msg="$2"
  if [ "$(severity_rank "$sev")" -gt "$(severity_rank "$WORST")" ]; then WORST="$sev"; fi
  case "$sev" in
    note) NOTES+=("$msg") ;;
    *) PROBLEMS+=("$msg") ;;
  esac
}

# ---------------------------------------------------------------- TLS certificates
CERT_JSON="["
for h in "${HOSTS[@]}"; do
  days=$(cert_days "$h")
  [ "$CERT_JSON" != "[" ] && CERT_JSON+=","
  if [ "$days" -lt 0 ]; then
    CERT_JSON+="{\"host\":\"$h\",\"daysRemaining\":null}"
    bump broken "no TLS certificate could be fetched for ${h} — is Caddy serving?"
  else
    CERT_JSON+="{\"host\":\"$h\",\"daysRemaining\":$days}"
    if [ "$days" -le "$CERT_CRIT_DAYS" ]; then
      bump critical "${h}: certificate expires in ${days} day(s) — Let's Encrypt renewal is failing"
    elif [ "$days" -le "$CERT_WARN_DAYS" ]; then
      bump warn "${h}: certificate expires in ${days} day(s) — renewal should have happened 30 days out"
    fi
  fi
done
CERT_JSON+="]"

# ---------------------------------------------------------------- issuing authority
CADDY_STATE="unknown"
if command -v systemctl >/dev/null 2>&1; then
  CADDY_STATE="$(systemctl is-active caddy 2>/dev/null || echo inactive)"
  [ "$CADDY_STATE" = "active" ] || bump broken "Caddy is ${CADDY_STATE} — certificates cannot be renewed while it is down"
fi

# ---------------------------------------------------------------- domain registration
DOMAIN_JSON="null"
DOMAIN_INFO=$(python3 - "$DOMAIN" <<'PYEOF' 2>/dev/null
import json, sys, urllib.request
domain = sys.argv[1]
for url in (f"https://rdap.nic.net.ng/domain/{domain}", f"https://rdap.org/domain/{domain}"):
    for _ in range(2):
        try:
            req = urllib.request.Request(url, headers={'accept': 'application/rdap+json'})
            with urllib.request.urlopen(req, timeout=15) as r:
                d = json.load(r)
            break
        except Exception:
            d = None
    if d:
        break
if not d:
    print(json.dumps({"ok": False}))
    sys.exit(0)
exp = None
for e in d.get('events', []):
    if e.get('eventAction') == 'expiration':
        exp = e.get('eventDate')
ns = [n.get('ldhName', '').lower() for n in d.get('nameservers', [])]
print(json.dumps({
    "ok": True,
    "expires": exp,
    "status": d.get('status', []),
    "nameservers": ns,
}))
PYEOF
)

# DNS and HTTPS are checked independently of RDAP: the registry API is flaky
# from this host, and a domain that has stopped answering must never be missed
# because a lookup failed.
DOMAIN_IPS="$DOMAIN_A"

if [ "$DOMAIN_LIVE" -eq 1 ]; then
  PROXIED=0
  case "$DOMAIN_IPS" in
    *188.114.*|*104.1[6-9].*|*172.6[4-9].*|*162.15[89].*) PROXIED=1 ;;
  esac
  if [ "$PROXIED" -eq 1 ]; then
    bump warn "${DOMAIN} resolves to Cloudflare proxy addresses (${DOMAIN_IPS}) — traffic is terminated by Cloudflare before reaching this server"
  elif ! echo "$DOMAIN_IPS" | grep -q "$NIPIO_IP"; then
    bump warn "${DOMAIN} resolves to ${DOMAIN_IPS}, not ${NIPIO_IP} — customers are not reaching this server"
  fi

  # Does the platform actually answer on the real domain?
  for h in "${DOMAIN}" "api.${DOMAIN}"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "https://${h}/" 2>/dev/null || echo 000)
    case "$code" in
      000) bump broken "https://${h}/ did not respond at all" ;;
      52[0-9])
        if [ "$PROXIED" -eq 1 ]; then
          bump broken "https://${h}/ returns ${code}: Cloudflare cannot complete TLS with this server. Either switch those DNS records to DNS-only (grey cloud) so Caddy can serve its own certificate, or install a Cloudflare Origin Certificate and set SSL/TLS to Full (strict)."
        else
          bump broken "https://${h}/ returns ${code} (TLS/origin failure)"
        fi
        ;;
      4*|5*) bump warn "https://${h}/ returns ${code}" ;;
    esac
  done
else
  bump note "domain ${DOMAIN} has no A records yet (not delegated/activated) — nothing to check there"
fi

if [ -n "$DOMAIN_INFO" ] && echo "$DOMAIN_INFO" | grep -q '"ok": *true'; then
  DOMAIN_JSON="$DOMAIN_INFO"
  exp_iso=$(echo "$DOMAIN_INFO" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("expires") or "")')
  ns_count=$(echo "$DOMAIN_INFO" | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("nameservers") or []))')
  if [ -n "$exp_iso" ]; then
    exp_epoch=$(date -d "$exp_iso" +%s 2>/dev/null || echo 0)
    if [ "$exp_epoch" -gt 0 ]; then
      ddays=$(( (exp_epoch - $(date +%s)) / 86400 ))
      if [ "$ddays" -le "$DOMAIN_CRIT_DAYS" ]; then
        bump critical "domain ${DOMAIN} expires in ${ddays} day(s) — renew now or the whole platform goes offline"
      elif [ "$ddays" -le "$DOMAIN_WARN_DAYS" ]; then
        bump warn "domain ${DOMAIN} expires in ${ddays} day(s) — turn on auto-renew / renew at the registrar"
      fi
    fi
  fi
  [ "$ns_count" -ge 2 ] || bump warn "domain ${DOMAIN} has ${ns_count} nameserver(s) published; registries expect at least 2"
else
  bump note "could not read the registry (RDAP) for ${DOMAIN} — expiry unverified today"
fi

# ---------------------------------------------------------------- backup watchdog cross-check
BACKUP_STATE="/root/coopengine/logs/backup-status.json"
if [ -f "$BACKUP_STATE" ]; then
  if ! grep -q '"healthy"[[:space:]]*:[[:space:]]*true' "$BACKUP_STATE"; then
    bump warn "the backup watchdog last reported a problem (see ${BACKUP_STATE})"
  fi
fi

# ---------------------------------------------------------------- output
JSON=$(cat <<JSONEOF
{
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "severity": "${WORST}",
  "certificates": ${CERT_JSON},
  "recipientCount": ${#PROBLEMS[@]},
  "domain": ${DOMAIN_JSON},
  "caddy": "${CADDY_STATE}",
  "problems": $(printf '%s\n' "${PROBLEMS[@]:-}" | python3 -c 'import json,sys;print(json.dumps([l for l in sys.stdin.read().split("\n") if l.strip()]))'),
  "notes": $(printf '%s\n' "${NOTES[@]:-}" | python3 -c 'import json,sys;print(json.dumps([l for l in sys.stdin.read().split("\n") if l.strip()]))')
}
JSONEOF
)
echo "$JSON" > "$LOG_DIR/domain-status.json"

if [ "$MODE" = "json" ]; then echo "$JSON"; exit 0; fi

if [ "$WORST" = "ok" ] && [ "$MODE" = "quiet" ]; then exit 0; fi

# De-duplicate: alert on a change of severity, daily while critical, weekly while warning.
prev_sev=""; prev_date=""
if [ -f "$STATE" ]; then IFS='|' read -r prev_sev prev_date < "$STATE" || true; fi
today=$(date +%F)
should_alert=0
case "$WORST" in
  ok)
    if [ "$prev_sev" != "ok" ] && [ -n "$prev_sev" ]; then should_alert=1; fi ;;
  critical|broken)
    [ "$prev_sev" != "$WORST" ] && should_alert=1
    [ "$prev_date" != "$today" ] && should_alert=1 ;;
  warn)
    [ "$prev_sev" != "warn" ] && should_alert=1
    if [ -n "$prev_date" ]; then
      age=$(( ( $(date -d "$today" +%s) - $(date -d "$prev_date" +%s) ) / 86400 ))
      [ "$age" -ge 3 ] && should_alert=1
    fi ;;
  note) should_alert=0 ;;
esac

if [ "$MODE" = "quiet" ] && [ "$should_alert" -eq 0 ]; then exit 0; fi

echo "${WORST}|${today}" > "$STATE"

echo "Co-opEngine domain & TLS watchdog — $(date -u +'%Y-%m-%d %H:%M UTC')"
echo "severity: ${WORST}"
case "$WORST" in
  ok) echo "✅ everything in order" ;;
  note) echo "ℹ️ notes only — nothing to act on" ;;
  warn) echo "⚠️ action needed soon" ;;
  critical) echo "🚨 act now" ;;
  broken) echo "🚨 something is down" ;;
esac
echo
if [ ${#PROBLEMS[@]} -gt 0 ]; then
  echo "Problems:"
  for p in "${PROBLEMS[@]}"; do echo "  • $p"; done
fi
if [ ${#NOTES[@]} -gt 0 ]; then
  echo "Notes:"
  for nt in "${NOTES[@]}"; do echo "  • $nt"; done
fi

echo
echo "Certificates (a proxied host shows the proxy's certificate, not this server's):"
for h in "${HOSTS[@]}"; do
  d=$(cert_days "$h")
  issuer=$(echo | timeout 12 openssl s_client -servername "$h" -connect "$h:443" 2>/dev/null \
    | openssl x509 -noout -issuer 2>/dev/null | sed 's/.*O *= *//; s/,.*//')
  tag=""
  case "$DOMAIN_IPS" in
    *188.114.*|*104.1[6-9].*|*172.6[4-9].*|*162.15[89].*) [ "$h" != "${NIPIO_IP}.nip.io" ] && case "$h" in *nip.io) ;; *) tag=" (edge certificate at the proxy, not ours)" ;; esac ;;
  esac
  if [ "$d" -lt 0 ]; then
    printf '  %-40s not served\n' "$h"
  else
    printf '  %-40s %s days left  %s%s\n' "$h" "$d" "${issuer:-unknown issuer}" "$tag"
  fi
done

if [ -n "$DOMAIN_IPS" ]; then
  echo
  echo "DNS: ${DOMAIN} -> ${DOMAIN_IPS}   (this server is ${NIPIO_IP})"
fi
echo
cat <<'FIXES'
What to do
  Certificates close to expiry  -> Caddy is down or port 80/443 is blocked for renewal:
                                   systemctl status caddy ; journalctl -u caddy -n 50
  Domain close to expiry        -> renew at the registrar; keep auto-renew on and the
                                   card valid. A lapsed domain takes everything offline.
  Proxy/origin TLS failures     -> either set the affected records to DNS-only in the DNS
                                   provider so Caddy serves its own certificate, or install
                                   an Origin Certificate and set SSL/TLS to Full (strict).
FIXES
