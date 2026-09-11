#!/usr/bin/env bash
# Switch Co-opEngine from the nip.io hostnames to the real domain.
#
#   scripts/switch-domain.sh --dry-run                     # check prerequisites only
#   scripts/switch-domain.sh coopengine.com.ng             # do the switch
#   scripts/switch-domain.sh --revert                      # go back to nip.io
#
# The nip.io hostnames are KEPT as aliases during the switch, so nothing breaks
# mid-transition and you can revert by pointing DNS away again.
set -euo pipefail

DOMAIN_DEFAULT="coopengine.com.ng"
NIP="169.58.196.141.nip.io"
VPS_IP="169.58.196.141"
CADDYFILE=/etc/caddy/Caddyfile
ENV_DIR=/root/coopengine
REPO=/root/CoopEngine-core
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

DRY=0
REVERT=0
FORCE=0
DOMAIN="$DOMAIN_DEFAULT"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --revert) REVERT=1 ;;
    --force) FORCE=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) DOMAIN="$arg" ;;
  esac
done

log() { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

export XDG_RUNTIME_DIR="/run/user/$(id -u)"

# --------------------------------------------------------------------- preflight
require_dns() {
  log "DNS check (each name must resolve to ${VPS_IP}):"
  local missing=0
  for h in "$DOMAIN" "api.$DOMAIN" "app.$DOMAIN" "member.$DOMAIN"; do
    local ip
    ip="$(dig +short A "$h" 2>/dev/null | tail -1)"
    if [ "$ip" = "$VPS_IP" ]; then
      printf '  %-32s -> %s  ok\n' "$h" "$ip"
    elif [ -z "$ip" ]; then
      printf '  %-32s     no A record      MISSING\n' "$h"
      missing=1
    else
      printf '  %-32s -> %s  WRONG (want %s)\n' "$h" "$ip" "$VPS_IP"
      missing=1
    fi
  done
  if [ "$missing" -ne 0 ]; then
    cat >&2 <<EOF

The domain does not point here yet. At your registrar create these A records
(TTL 300-3600), then re-run:

  @        A   ${VPS_IP}
  www      A   ${VPS_IP}
  api      A   ${VPS_IP}
  app      A   ${VPS_IP}
  member   A   ${VPS_IP}

Optional, for the e-mail leg (SPF/DKIM/DMARC values come from your mail provider):

  @        TXT "v=spf1 include:<provider> -all"
  _dmarc   TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN}"

For local mail: ask me for a full SPF/DKIM/DMARC set once SMTP is chosen.
EOF
    if [ "$FORCE" -eq 1 ]; then
      log "WARNING: continuing anyway (--force). Certificate issuance may fail."
    else
      fail "prerequisites not met (use --force only if you know DNS is already correct)"
    fi
  fi
}

require_services() {
  log "Service check:"
  for svc in coopengine-api coopengine-portal coopengine-pwa; do
    local state
    state="$(systemctl --user is-active "$svc" 2>/dev/null || true)"
    printf '  %-20s %s\n' "$svc" "${state:-unknown}"
    [ "$state" = "active" ] || fail "$svc is not active — fix that first"
  done
  curl -sf "http://127.0.0.1:3999/api/v1/health" >/dev/null || fail "the API is not answering on :3999"
  log "  api health            ok"
}

# ----------------------------------------------------------------------- actions
write_caddyfile() {
  local api_hosts app_hosts member_hosts
  if [ "$REVERT" -eq 1 ]; then
    api_hosts="api.${NIP}"
    app_hosts="app.${NIP}"
    member_hosts="member.${NIP}"
  else
    # real name first, nip.io kept as an alias so both keep working
    api_hosts="api.${DOMAIN}, api.${NIP}"
    app_hosts="app.${DOMAIN}, app.${NIP}"
    member_hosts="member.${DOMAIN}, member.${NIP}"
  fi

  # The apex and www have no application of their own, so they redirect to the
  # staff portal. Omitted on revert, where there is no domain to redirect from.
  local apex_block=""
  if [ "$REVERT" -eq 0 ]; then
    apex_block="
# Apex and www: no application of their own — send visitors to the staff portal.
${DOMAIN}, www.${DOMAIN} {
	import security_headers
	redir https://app.${DOMAIN}{uri} permanent
}

"
  fi

  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<EOF
{
	email yikwab.a@gmail.com
}

# Hostnames: real domain (when configured) plus the nip.io aliases, so the
# switchover is reversible without downtime.

(security_headers) {
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy "geolocation=(), microphone=(), camera=()"
		-Server
	}
}

${apex_block}${api_hosts} {
	import security_headers
	encode zstd gzip
	reverse_proxy 127.0.0.1:3999
	log {
		output file /var/log/caddy/api-access.log
		format json
	}
}

${app_hosts} {
	import security_headers
	encode zstd gzip
	reverse_proxy 127.0.0.1:3100
	log {
		output file /var/log/caddy/app-access.log
		format json
	}
}

${member_hosts} {
	import security_headers
	encode zstd gzip
	reverse_proxy 127.0.0.1:3200
	log {
		output file /var/log/caddy/member-access.log
		format json
	}
}
EOF

  if [ "$DRY" -eq 1 ]; then
    log "--- Caddyfile that WOULD be installed ---"
    sed 's/^/  /' "$tmp"
    rm -f "$tmp"
    return
  fi
  cp "$CADDYFILE" "${ENV_DIR}/Caddyfile.bak-${STAMP}"
  install -m 644 "$tmp" "$CADDYFILE"
  rm -f "$tmp"
  log "Caddyfile updated (backup: ${ENV_DIR}/Caddyfile.bak-${STAMP})"
}

update_cors() {
  local cors
  if [ "$REVERT" -eq 1 ]; then
    cors="https://app.${NIP},https://member.${NIP}"
  else
    cors="https://app.${DOMAIN},https://member.${DOMAIN},https://app.${NIP},https://member.${NIP}"
  fi
  if [ "$DRY" -eq 1 ]; then
    log "CORS_ORIGINS would become: $cors"
    return
  fi
  cp "${ENV_DIR}/api.env" "${ENV_DIR}/api.env.bak-${STAMP}"
  python3 - "$ENV_DIR/api.env" "$cors" <<'PY'
import pathlib, sys
path, cors = sys.argv[1], sys.argv[2]
p = pathlib.Path(path)
lines = p.read_text().splitlines()
out, seen = [], False
for line in lines:
    if line.startswith('CORS_ORIGINS='):
        out.append(f'CORS_ORIGINS={cors}')
        seen = True
    else:
        out.append(line)
if not seen:
    out.append(f'CORS_ORIGINS={cors}')
p.write_text('\n'.join(out) + '\n')
PY
  log "CORS_ORIGINS updated (backup: ${ENV_DIR}/api.env.bak-${STAMP})"
}

rebuild_web() {
  local url
  if [ "$REVERT" -eq 1 ]; then
    url="https://api.${NIP}/api/v1"
  else
    url="https://api.${DOMAIN}/api/v1"
  fi
  if [ "$DRY" -eq 1 ]; then
    log "portal + PWA would be rebuilt with NEXT_PUBLIC_API_URL=$url"
    return
  fi
  ( cd "$REPO/apps/portal" && NEXT_PUBLIC_API_URL="$url" pnpm build >/tmp/switch-portal-build.log 2>&1 ) \
    || fail "portal build failed (see /tmp/switch-portal-build.log)"
  ( cd "$REPO/apps/member-pwa" && NEXT_PUBLIC_API_URL="$url" pnpm build >/tmp/switch-pwa-build.log 2>&1 ) \
    || fail "PWA build failed (see /tmp/switch-pwa-build.log)"
  log "portal + PWA rebuilt against $url"
}

restart_all() {
  if [ "$DRY" -eq 1 ]; then
    log "services would be restarted; Caddy reloaded"
    return
  fi
  systemctl --user restart coopengine-api coopengine-portal coopengine-pwa
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  for i in $(seq 1 30); do
    curl -sf "http://127.0.0.1:3999/api/v1/health" >/dev/null && break
    sleep 1
  done
  log "services restarted, Caddy reloaded"
}

verify() {
  local base api app member
  if [ "$REVERT" -eq 1 ]; then
    api="https://api.${NIP}"; app="https://app.${NIP}"; member="https://member.${NIP}"
  else
    api="https://api.${DOMAIN}"; app="https://app.${DOMAIN}"; member="https://member.${DOMAIN}"
  fi
  [ "$DRY" -eq 1 ] && { log "verification would run against ${api}"; return; }

  log "waiting for certificate issuance (up to 90s)…"
  for i in $(seq 1 30); do
    if curl -sf --max-time 8 "${api}/api/v1/health" >/dev/null 2>&1; then break; fi
    sleep 3
  done

  local ok=0 fail_n=0
  for url in \
    "${api}/api/v1/health" "${api}/docs" \
    "${app}/" "${app}/members" "${app}/loans" "${app}/month-end" \
    "${app}/withdrawals" "${app}/month-end" "${app}/opening-balances" "${app}/analytics" \
    "${member}/" "${member}/manifest.webmanifest"; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url" || echo 000)"
    if [ "$code" = "200" ]; then ok=$((ok+1)); else fail_n=$((fail_n+1)); printf '  %-70s %s\n' "$url" "$code"; fi
  done
  printf '  routes ok: %s   failing: %s\n' "$ok" "$fail_n"

  log "certificate:"
  echo | openssl s_client -servername "$(echo "$api" | sed 's|https://||;s|/.*||')" \
    -connect "$(echo "$api" | sed 's|https://||;s|/.*||'):443" 2>/dev/null \
    | openssl x509 -noout -issuer -dates -ext subjectAltName 2>/dev/null | sed 's/^/  /' || true

  [ "$fail_n" -eq 0 ] || log "NOTE: some routes failed — check Caddy: journalctl -u caddy -n 50"
}

main() {
  if [ "$REVERT" -eq 1 ]; then
    log "=== REVERTING to nip.io hostnames ==="
  else
    log "=== switching to ${DOMAIN} ==="
  fi
  [ "$DRY" -eq 1 ] && log "(dry run — nothing will be changed)"

  require_services
  [ "$REVERT" -eq 1 ] || require_dns
  write_caddyfile
  update_cors
  rebuild_web
  restart_all
  verify

  log
  if [ "$DRY" -eq 1 ]; then
    log "Dry run complete. Re-run without --dry-run to apply."
  else
    log "Done. Both ${DOMAIN} and the nip.io names now serve the stack."
    log "Roll back any time with: scripts/switch-domain.sh --revert"
  fi
}

main
