#!/usr/bin/env bash
# Dedicated NexControl HTTPS repair: keep other Nginx sites and bot services untouched.
set -Eeuo pipefail
umask 077
[[ $(id -u) -eq 0 ]] || { echo 'Root required'; exit 2; }
DOMAIN='nxc.31-56-85-53.sslip.io'
CONF="/etc/nginx/conf.d/99-nxc-exclusive.conf"
ROOT='/var/www/nxc-acme'
CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
CONFIG='/etc/nxc-vps/config.json'
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
say(){ printf '[NXC] %s\n' "$*"; }
for bin in nginx systemctl curl python3 timeout; do command -v "$bin" >/dev/null || { say "Missing $bin";exit 2; }; done
systemctl is-active --quiet nginx || { say 'Nginx is not active'; exit 2; }
local_ok(){ curl -fsS --max-time 5 http://127.0.0.1:18731/healthz | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d.get("ok") and d.get("service")=="nexcontrol-vps"'; }
tls_ok(){ curl --noproxy '*' -fsS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d.get("ok") and d.get("service")=="nexcontrol-vps"'; }
tls_diagnostics(){
  local state body_code
  state="$(curl --noproxy '*' -ksS --resolve "$DOMAIN:443:127.0.0.1" --connect-timeout 3 --max-time 8 -o /dev/null -w '%{http_code}' "https://$DOMAIN/healthz" 2>/dev/null || echo unreachable)"
  printf '[NXC] Local TLS HTTP status: %s (network bypasses external proxy)\n' "$state"
  nginx -T >/dev/null 2>&1 || say 'Nginx config currently invalid'
  if command -v openssl >/dev/null && [[ -r "$CERT" ]]; then
    openssl x509 -in "$CERT" -noout -subject -dates 2>/dev/null | sed 's/^/[NXC] Certificate /' || true
  fi
}
local_ok >/dev/null || { say 'LOCAL_GATEWAY=NOT_READY; no Nginx changes';exit 1; }
[[ -s "$CONFIG" ]] || { say 'NexControl config missing'; exit 1; }
nginx -T > "$TMP/nginx-before" 2>"$TMP/nginx-warnings" || { say 'Existing Nginx config invalid';exit 1; }
# Some VPS installations load sites-enabled/* but not conf.d/*. A file in an
# inactive folder can pass nginx -t yet never serve a single request.
# Check Nginx's *effective* config before choosing the dedicated vhost path.
if [[ -e "$CONF" ]] && ! grep -Fq "# configuration file $CONF:" "$TMP/nginx-before"; then
  say "Existing NexControl conf.d file is not loaded by active Nginx."
fi
if ! grep -Eq '^[[:space:]]*include[[:space:]]+/etc/nginx/conf[.]d/\*([.]conf)?;' "$TMP/nginx-before"; then
  if grep -Eq '^[[:space:]]*include[[:space:]]+/etc/nginx/sites-enabled/\*([.]conf)?;' "$TMP/nginx-before"; then
    if grep -Eq '^[[:space:]]*include[[:space:]]+/etc/nginx/sites-enabled/\*[.]conf;' "$TMP/nginx-before"; then
      CONF="/etc/nginx/sites-enabled/99-nxc-exclusive.conf"
    else
      CONF="/etc/nginx/sites-enabled/99-nxc-exclusive"
    fi
    say "Active Nginx uses sites-enabled; deploying only the dedicated NexControl vhost there."
  else
    say "No supported active conf.d/sites-enabled include; refusing to modify global nginx.conf."
    exit 1
  fi
fi
if grep -F 'conflicting server name' "$TMP/nginx-warnings" | grep -Fq "$DOMAIN"; then
  say "Nginx already reports a duplicate virtual host for $DOMAIN; stopping before altering routing."
  exit 1
fi
if [[ -e "$CONF" ]]; then
  grep -Fq '# managed: NexControl dedicated host' "$CONF" || { say 'Refusing to overwrite a foreign Nginx config'; exit 1; }
  cp -a "$CONF" "$TMP/previous.conf"
elif grep -Fq "server_name $DOMAIN" "$TMP/nginx-before"; then
  say 'Dedicated hostname is already used by a different Nginx site'; exit 1
fi
restore(){
  if [[ -f "$TMP/previous.conf" ]]; then cp -a "$TMP/previous.conf" "$CONF"; else rm -f "$CONF"; fi
  if nginx -t >/dev/null 2>&1; then systemctl reload nginx || true; fi
}
fail(){ say "$1 -- restoring previous Nginx configuration"; restore; exit 1; }
install -d -m 0755 "$ROOT/.well-known/acme-challenge"
if [[ ! -s "$CERT" || ! -s "$KEY" ]]; then
  cat > "$CONF" <<NGINX
# managed: NexControl dedicated host
server {
  listen 80;
  server_name $DOMAIN;
  location /.well-known/acme-challenge/ { root $ROOT; }
  location / { return 404; }
}
NGINX
  if ! nginx -t >/dev/null 2>&1 || ! systemctl reload nginx; then fail 'Temporary HTTP vhost failed'; fi
  if ! command -v certbot >/dev/null; then
    say 'Installing certbot (time limited)'
    if ! (timeout 150 apt-get update -qq && timeout 150 apt-get install -y -qq certbot) > "$TMP/apt.log" 2>&1; then fail 'Certbot installation failed'; fi
  fi
  ARGS=(--non-interactive --agree-tos --keep-until-expiring)
  if [[ -n "${NXC_LE_EMAIL:-}" ]]; then ARGS+=(--email "$NXC_LE_EMAIL"); else ARGS+=(--register-unsafely-without-email); fi
  if ! timeout 155 certbot certonly --webroot -w "$ROOT" -d "$DOMAIN" "${ARGS[@]}" > "$TMP/acme.log" 2>&1; then fail 'Could not issue certificate (DNS or port 80)'; fi
fi
[[ -s "$CERT" && -s "$KEY" ]] || fail 'Missing certificate files'
cat > "$CONF" <<NGINX
# managed: NexControl dedicated host
server {
  listen 80;
  server_name $DOMAIN;
  location /.well-known/acme-challenge/ { root $ROOT; }
  location / { return 301 https://\$host\$request_uri; }
}
server {
  listen 443 ssl;
  server_name $DOMAIN;
  ssl_certificate $CERT;
  ssl_certificate_key $KEY;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_tickets off;
  client_max_body_size 3m;
  location / {
    proxy_pass http://127.0.0.1:18731;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 65s;
  }
}
NGINX
if ! nginx -t >/dev/null 2>&1 || ! systemctl reload nginx; then fail 'TLS Nginx validation failed'; fi
# Avoid claiming a deployment works if Nginx silently ignored the configuration.
if ! nginx -T > "$TMP/nginx-after" 2>"$TMP/nginx-after-warnings"; then
  fail 'Unable to inspect effective Nginx config after reload'
fi
if ! grep -Fq "# configuration file $CONF:" "$TMP/nginx-after"; then
  fail 'Nginx did not load the dedicated NexControl virtual host'
fi
if grep -F 'conflicting server name' "$TMP/nginx-after-warnings" | grep -Fq "$DOMAIN"; then
  fail 'Nginx reports another vhost overriding the NexControl hostname'
fi
if ! tls_ok >/dev/null 2>&1; then tls_diagnostics; fail 'TLS local health check failed'; fi
cp -a "$CONFIG" "$TMP/config-old"
install -d -m 0700 /var/backups/nxc-vps
cp -a "$CONFIG" "/var/backups/nxc-vps/config-pre-https-$(date -u +%Y%m%d%H%M%S).json"
if ! python3 - "$CONFIG" "$DOMAIN" <<'PY'
import json,os,sys
from pathlib import Path
p=Path(sys.argv[1]);d=json.loads(p.read_text())
assert d.get('password_hash') and d.get('agent_key')
d['domain']=sys.argv[2]
tmp=p.with_suffix('.tmp')
tmp.write_text(json.dumps(d));os.chmod(tmp,0o600);os.replace(tmp,p)
PY
then
  cp -a "$TMP/config-old" "$CONFIG"
  fail 'Invalid gateway config; preserved existing authentication'
fi
if ! systemctl restart nxc-vps-gateway.service || ! local_ok >/dev/null 2>&1 || ! tls_ok >/dev/null 2>&1; then
  cp -a "$TMP/config-old" "$CONFIG"
  systemctl restart nxc-vps-gateway.service || true
  fail 'New gateway Origin failed; auth configuration restored'
fi
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/98-nxc-reload.sh <<'HOOK'
#!/bin/sh
nginx -t >/dev/null 2>&1 && systemctl reload nginx
HOOK
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/98-nxc-reload.sh
say 'LOCAL_GATEWAY=READY; HTTPS_SNI=READY'
if curl --noproxy '*' -fsS --max-time 15 "https://$DOMAIN/healthz" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d.get("service")=="nexcontrol-vps"' >/dev/null 2>&1; then
  say 'PUBLIC_TLS=READY'
else
  say 'PUBLIC_TLS=NOT_VERIFIED_FROM_VPS (DNS/firewall may differ)'
fi
say "NexControl: https://$DOMAIN/nexcontrol/"
say "NexAI: https://$DOMAIN/nexai/"
say 'Previous Nginx sites and bot services preserved.'
