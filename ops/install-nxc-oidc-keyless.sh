#!/usr/bin/env bash
# NexControl one-paste keyless GitHub OIDC administration bootstrap.
# This opens ONLY a TLS listener on :18473; no SSH key, GitHub PAT,
# Vercel, Supabase, Nginx replacement, or Telegram/WhatsApp unit restarts.
set -Eeuo pipefail
umask 077
if [[ "$(id -u)" != 0 ]]; then
  echo "[NXC] Run this one-paste command as root or under sudo bash." >&2
  exit 2
fi
say(){ printf '[NXC KEYLESS] %s\n' "$*"; }
for x in curl python3 openssl systemctl; do
  command -v "$x" >/dev/null || { say "Missing executable: $x"; exit 2; }
done
HOST='nxc.31-56-85-53.sslip.io'
REV='5d6e8bf1a6e343c273350482fb8398483b5f6cdf'
SOURCE="https://raw.githubusercontent.com/Nexus-tech-01/NexTelegrambots/$REV/ops/nxc-oidc-vps-server.py"
DIR='/opt/nxc-oidc-vps'
STATE='/var/lib/nxc-oidc-vps'
CERT="/etc/letsencrypt/live/$HOST/fullchain.pem"
KEY="/etc/letsencrypt/live/$HOST/privkey.pem"
UNIT='/etc/systemd/system/nxc-oidc-vps.service'
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say 'Installing independent NexControl administration transport.'
say 'Authentication: signed GitHub Actions OIDC (no GitHub user token).'
install -d -m 0700 "$DIR" "$STATE"
curl -fsSL --retry 3 --connect-timeout 12 --max-time 70 "$SOURCE" -o "$TMP/agent.py"
python3 -m py_compile "$TMP/agent.py"

if ! python3 -c 'from cryptography.hazmat.primitives.asymmetric import rsa' >/dev/null 2>&1; then
  say 'Installing Debian python3-cryptography for RSA signature verification.'
  export DEBIAN_FRONTEND=noninteractive
  if ! (timeout 150 apt-get update -qq && timeout 150 apt-get install -y -qq python3-cryptography) > "$TMP/pkg.log" 2>&1; then
    say 'Cryptography dependency could not be installed; existing services were not changed.'
    exit 1
  fi
fi
if [[ ! -s "$CERT" || ! -s "$KEY" ]]; then
  say "No Let's Encrypt certificate for $HOST found."
  say 'Cannot expose an administrator endpoint without a validated TLS identity.'
  exit 1
fi
if ! openssl x509 -in "$CERT" -checkend 7200 -noout >/dev/null 2>&1; then
  say 'NexControl TLS certificate expires too soon or is invalid.'
  exit 1
fi
if ! openssl x509 -in "$CERT" -noout -checkhost "$HOST" 2>/dev/null | grep -iq 'does match'; then
  say 'NexControl certificate does not match dedicated hostname.'
  exit 1
fi

if [[ -f "$DIR/server.py" ]]; then
  cp -a "$DIR/server.py" "$DIR/server.py.bak-$(date -u +%Y%m%d%H%M%S)"
fi
install -m 0700 "$TMP/agent.py" "$DIR/server.py"
cat > "$UNIT" <<'UNIT'
[Unit]
Description=NexControl Keyless GitHub OIDC Admin Transport (independent of Vercel)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=root
Group=root
UMask=0077
WorkingDirectory=/opt/nxc-oidc-vps
ExecStart=/usr/bin/python3 -u /opt/nxc-oidc-vps/server.py
Restart=always
RestartSec=8
NoNewPrivileges=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LimitNOFILE=4096
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now nxc-oidc-vps.service
systemctl restart nxc-oidc-vps.service
sleep 2
if ! systemctl is-active --quiet nxc-oidc-vps.service; then
  say 'OIDC service failed local startup; other services were not restarted.'
  systemctl show nxc-oidc-vps.service -p ActiveState -p Result -p ExecMainStatus --no-pager
  exit 1
fi

if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  ufw allow 18473/tcp comment 'NexControl GitHub OIDC' >/dev/null || true
  say 'Enabled narrow UFW TCP 18473 inbound rule.'
fi

if curl --noproxy '*' --resolve "$HOST:18473:127.0.0.1" \
    -fsS --max-time 8 "https://$HOST:18473/healthz" |
    python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["service"]=="nxc-oidc-vps"' >/dev/null; then
  say 'LOCAL_HTTPS_ADMIN_BRIDGE=READY'
else
  say 'LOCAL_HTTPS_ADMIN_BRIDGE=NOT_READY'
  exit 1
fi
say 'Private control repository: Tresor562/Nexus-lab'
say 'External port: TCP 18473 (provider firewall must allow GitHub Actions).'
say 'No password, GitHub token or SSH key created or requested.'
say 'Nginx, NexControl gateway, Telegram/WhatsApp/KnowMe untouched.'
say 'To revoke: systemctl disable --now nxc-oidc-vps.service'
say 'Ask ChatGPT to send the private NexControl ping ticket now.'
