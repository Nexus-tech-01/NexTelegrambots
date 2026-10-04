#!/usr/bin/env bash
set -euo pipefail

TOKEN="${1:-${NEXCONTROL_SETUP_TOKEN:-}}"
NAME="${2:-${NEXCONTROL_AGENT_NAME:-NexControl Host}}"
SUPABASE_URL="https://ojbyvjqurlamplmujmyu.supabase.co"
PUBLISHABLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qYnl2anF1cmxhbXBsbXVqbXl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxNDM4ODIsImV4cCI6MjEwMjcxOTg4Mn0.HXZEqfMQ9Z4-M8TkvFF-vnTHaW6HBQjWLboflPz_ekE"
AGENT_URL="https://raw.githubusercontent.com/Nexus-tech-01/NexTelegrambots/de07bda029a32fb16787908d17bd882d69128edd/ops/nexforge-host-agent.py"
AGENT_SHA256="84a99474023b46c92c3d5c733fa43604783e7bad8dda1a3ccd76588a0667d81e"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root." >&2
  exit 1
fi
if [ "${#TOKEN}" -lt 20 ]; then
  echo "Missing or invalid NexControl setup token." >&2
  exit 1
fi
for cmd in python3 curl sha256sum systemctl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 1; }
done

install -d -m 0755 /opt/nexforge-host-agent
install -d -m 0700 /var/lib/nexforge-host-agent/backups
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL --retry 3 --connect-timeout 10 "$AGENT_URL" -o "$tmp"
echo "$AGENT_SHA256  $tmp" | sha256sum -c -
install -m 0755 "$tmp" /opt/nexforge-host-agent/agent.py

cat >/etc/nexforge-host-agent.env <<EOF
SUPABASE_URL='$SUPABASE_URL'
PUBLISHABLE_KEY='$PUBLISHABLE_KEY'
SETUP_TOKEN='$TOKEN'
AGENT_NAME='${NAME//\'/}'
EOF
chmod 600 /etc/nexforge-host-agent.env

cat >/etc/systemd/system/nexforge-host-agent.service <<'EOF'
[Unit]
Description=NexControl Host Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/nexforge-host-agent.env
ExecStart=/usr/bin/python3 /opt/nexforge-host-agent/agent.py
Restart=always
RestartSec=4
User=root
WorkingDirectory=/opt/nexforge-host-agent
NoNewPrivileges=false

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now nexforge-host-agent.service
sleep 3
systemctl --no-pager --full status nexforge-host-agent.service | sed -n '1,14p'
echo
echo "NexControl host agent installed. The setup token is single-use and will be replaced by the agent credential after registration."
