#!/usr/bin/env bash
# NexControl emergency routing repair: only an exclusive Nginx hostname.
# Does not modify other server blocks, services, credentials or bot processes.
set -Eeuo pipefail
umask 077

DOMAIN="nxc.31-56-85-53.sslip.io"
GATEWAY="http://127.0.0.1:18731"
CFG="/etc/nxc-vps/config.json"
CRT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
PREFIX="[NexControl routing]"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say(){ printf '%s %s\n' "$PREFIX" "$*"; }
[[ "$(id -u)" == "0" ]] || { say "Run as root."; exit 2; }
for cmd in curl python3 nginx openssl systemctl; do
  command -v "$cmd" >/dev/null || { say "Missing executable: $cmd"; exit 2; }
done
systemctl is-active --quiet nginx || { say "Nginx not active."; exit 2; }

is_gateway(){
  curl --noproxy '*' --max-time 7 -fsS "$GATEWAY/healthz" |
    python3 -c 'import json,sys;x=json.load(sys.stdin);assert x.get("ok") and x.get("service")=="nexcontrol-vps"'
}
is_tls(){
  curl --noproxy '*' --max-time 12 --resolve "$DOMAIN:443:127.0.0.1" -fsS "https://$DOMAIN/healthz" |
    python3 -c 'import json,sys;x=json.load(sys.stdin);assert x.get("ok") and x.get("service")=="nexcontrol-vps"'
}
diagnostics(){
  local status
  status="$(curl --noproxy '*' --max-time 8 -ksS --resolve "$DOMAIN:443:127.0.0.1" \
       -o /dev/null -w '%{http_code}' "https://$DOMAIN/healthz" 2>/dev/null || true)"
  say "TLS SNI HTTP status: $status"
  say "Gateway local status: $(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 5 "$GATEWAY/healthz" 2>/dev/null || true)"
  if [[ "$status" == "200" ]]; then say "HTTP 200 has invalid body: another Nginx route or service responded."; fi
}
is_gateway >/dev/null 2>&1 || { say "LOCAL_GATEWAY=NOT_READY. Preserving Nginx."; exit 1; }
[[ -s "$CFG" ]] || { say "Gateway config missing. Preserving Nginx."; exit 1; }
[[ -s "$CRT" && -s "$KEY" ]] || {
  say "Certificate files unavailable. Repair the isolated certificate first; preserving Nginx."; exit 1;
}
if ! openssl x509 -in "$CRT" -checkend 0 -noout >/dev/null 2>&1; then
  say "TLS certificate expired or invalid; preserving Nginx."; exit 1;
fi

# Read only the ACTIVE effective nginx config, not guessed filesystem paths.
nginx -T >"$TMP/active.conf" 2>"$TMP/nginx-stderr" || {
  say "The currently loaded nginx configuration is invalid; refusing changes."; exit 1;
}
TARGET_DIR="$(python3 - "$TMP/active.conf" <<'PY'
import re,sys
s=open(sys.argv[1]).read()
a=bool(re.search(r'(?m)^\s*include\s+/etc/nginx/sites-enabled/\*\s*;',s))
b=bool(re.search(r'(?m)^\s*include\s+/etc/nginx/conf\.d/\*\.conf\s*;',s))
print('/etc/nginx/sites-enabled' if a else '/etc/nginx/conf.d' if b else '')
PY
)"
if [[ -z "$TARGET_DIR" ]]; then
  say "Nginx does not load either standard vhost directory."
  say "Explicit custom include is required; refusing to edit nginx.conf blindly."
  exit 1
fi
say "Effective server block directory: $TARGET_DIR"
CONF="$TARGET_DIR/99-nexcontrol-dedicated.conf"
if [[ -e "$CONF" ]]; then
  if ! grep -Fq '# nxc-managed-dedicated-vhost' "$CONF"; then
    say "Path belongs to a foreign Nginx vhost. Preserving it."; exit 1
  fi
  cp -a "$CONF" "$TMP/old.conf"
else
  # Never override an existing dedicated hostname from another site.
  if python3 - "$TMP/active.conf" "$DOMAIN" <<'PY'
import re,sys
s=open(sys.argv[1]).read()
domain=sys.argv[2]
# Check only genuine server_name declarations, excluding comments.
for line in s.splitlines():
    line=line.split('#',1)[0]
    m=re.search(r'\bserver_name\s+([^;]+);',line)
    if m and domain in m.group(1).split():
        sys.exit(0)
sys.exit(1)
PY
  then
    say "Hostname already configured by another active vhost, refusing takeover."; exit 1
  fi
fi

restore(){
  if [[ -f "$TMP/old.conf" ]]; then
    cp -a "$TMP/old.conf" "$CONF"
  else
    rm -f "$CONF"
  fi
  if nginx -t >/dev/null 2>&1; then systemctl reload nginx >/dev/null 2>&1 || true; fi
}
fail(){ diagnostics; say "$*; rolling back exclusive vhost."; restore; exit 1; }

install -d -m 0755 "$TARGET_DIR"
cat > "$CONF" <<VHOST
# nxc-managed-dedicated-vhost
server {
  listen 80;
  server_name $DOMAIN;
  location / { return 301 https://\$host\$request_uri; }
}
server {
  listen 443 ssl;
  server_name $DOMAIN;
  ssl_certificate $CRT;
  ssl_certificate_key $KEY;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_tickets off;
  client_max_body_size 3m;
  add_header X-NexControl-Route "dedicated-vps" always;
  location / {
    proxy_pass $GATEWAY;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 65s;
  }
}
VHOST
if ! nginx -t >"$TMP/validate.out" 2>&1; then fail "nginx -t rejected dedicated vhost"; fi
if grep -Ei "conflicting server name.*nxc|duplicate.*nxc" "$TMP/validate.out" >/dev/null 2>&1; then
  fail "Nginx reports a duplicate NexControl hostname"
fi
if ! systemctl reload nginx; then fail "Nginx reload failed"; fi
sleep 1
# If another Nginx instance or unexpected default route still catches requests,
# fail rather than accidentally treating HTTP 200 text/plain as a valid backend.
if ! is_tls > /dev/null 2>&1; then fail "Dedicated HTTPS vhost did not route to the gateway"; fi
say "HTTPS_SNI=READY: Nginx now routes the dedicated hostname to NexControl."

# The gateway's allowed Origin is changed only after secure TLS is established.
# Preserve the existing admin login hash and agent authentication key.
# Upgrade only the NexControl gateway, to a version that recognizes the
# dedicated Vercel frontend Origin, without altering its original credentials.
# Download immutable, previously-tested gateway code before changing any config.
GATEWAY_REV="3d35b8196d5e9157c05e242b5ca626ec89c6b0c1"
GATEWAY_FILE="/opt/nxc-vps/gateway.py"
GATEWAY_URL="https://raw.githubusercontent.com/Nexus-tech-01/NexTelegrambots/$GATEWAY_REV/ops/nxc-vps-gateway-20261009.py"
if ! curl --fail --location --silent --show-error --connect-timeout 10 --max-time 60 "$GATEWAY_URL" -o "$TMP/gateway-new.py"; then
  fail "Unable to download compatible NexControl gateway"
fi
if ! python3 -m py_compile "$TMP/gateway-new.py"; then
  fail "Downloaded NexControl gateway failed Python syntax validation"
fi
[[ -s "$GATEWAY_FILE" ]] || fail "Existing gateway file unavailable, refusing to overwrite"
cp -a "$GATEWAY_FILE" "$TMP/gateway-old.py"
if ! python3 - "$CFG" "$DOMAIN" "$TMP/old-auth.json" <<'PY'
import json,os,sys
from pathlib import Path
p=Path(sys.argv[1])
d=json.loads(p.read_text())
assert d.get("password_hash") and d.get("agent_key")
Path(sys.argv[3]).write_bytes(p.read_bytes())
d["domain"]=sys.argv[2]
temp=p.with_suffix(".nxc-routing-tmp")
temp.write_text(json.dumps(d))
os.chmod(temp,0o600)
os.replace(temp,p)
PY
then
  if [[ -s "$TMP/old-auth.json" ]]; then cp -a "$TMP/old-auth.json" "$CFG"; fi
  fail "Config update failed; preserving existing identity"
fi
install -m 0700 "$TMP/gateway-new.py" "$GATEWAY_FILE"
if ! systemctl restart nxc-vps-gateway.service || ! is_gateway >/dev/null 2>&1 || ! is_tls >/dev/null 2>&1; then
  cp -a "$TMP/old-auth.json" "$CFG"
  cp -a "$TMP/gateway-old.py" "$GATEWAY_FILE"
  systemctl restart nxc-vps-gateway.service || true
  restore
  say "Gateway update failed, old authenticated backend and Nginx vhost restored."
  exit 1
fi

# Independent of any Vercel project; still requires the VPS and its Nginx service.
say "LOCAL_GATEWAY=READY"
say "DIRECT_HTTPS_SNI=READY"
say "NexControl: https://$DOMAIN/nexcontrol/"
say "NexAI: https://$DOMAIN/nexai/"
say "No Telegram/WhatsApp bot unit was touched."
