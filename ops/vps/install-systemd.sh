#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "install-systemd.sh must run as root" >&2
  exit 1
fi

repo_root="${1:-/opt/nex/current}"
unit_src="$repo_root/ops/vps/systemd"

for unit in nexcontrol-agent.service nex-resource-watchdog.service; do
  if [[ ! -f "$unit_src/$unit" ]]; then
    echo "Missing $unit_src/$unit" >&2
    exit 1
  fi
  install -o root -g root -m 0644 "$unit_src/$unit" "/etc/systemd/system/$unit"
done

if [[ ! -f /etc/nex/nexcontrol-agent.json ]]; then
  install -o root -g nex -m 0640 "$repo_root/ops/vps/nexcontrol-agent.config.example.json" /etc/nex/nexcontrol-agent.json
  echo "Created /etc/nex/nexcontrol-agent.json from template. Review it before starting services."
fi

if [[ ! -f /etc/nex/env/nexcontrol-agent.env ]]; then
  install -o root -g nex -m 0640 "$repo_root/ops/vps/nexcontrol-agent.env.example" /etc/nex/env/nexcontrol-agent.env
  echo "Created /etc/nex/env/nexcontrol-agent.env. Fill NEXCONTROL_AGENT_KEY before starting the agent."
fi

systemctl daemon-reload
systemctl enable nexcontrol-agent.service nex-resource-watchdog.service

cat <<'EOF'
Systemd units installed and enabled.

Do not start the NexControl Agent until:
  1. /etc/nex/env/nexcontrol-agent.env contains the real agent key
  2. /etc/nex/nexcontrol-agent.json has been reviewed
  3. /opt/nex/current points to the intended release

Then run:
  systemctl start nexcontrol-agent
  journalctl -u nexcontrol-agent -f

Start the resource watchdog only after the agent/runtime paths have been verified:
  systemctl start nex-resource-watchdog
EOF
