#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "activate-control-plane.sh must run as root" >&2
  exit 1
fi

agent_env=/etc/nex/env/nexcontrol-agent.env
agent_cfg=/etc/nex/nexcontrol-agent.json

env_value(){
  local file="$1" key="$2"
  awk -F= -v k="$key" '$1==k{v=substr($0,index($0,"=")+1);gsub(/^[[:space:]]+|[[:space:]]+$/,"",v);print v}' "$file" 2>/dev/null | tail -1
}

[[ -f "$agent_env" ]] || { echo "Missing $agent_env" >&2; exit 1; }
[[ -f "$agent_cfg" ]] || { echo "Missing $agent_cfg" >&2; exit 1; }
jq empty "$agent_cfg" >/dev/null

key="$(env_value "$agent_env" NEXCONTROL_AGENT_KEY)"
[[ -n "$key" ]] || key="$(env_value "$agent_env" NEXCONTROL_FLEET_KEY)"
[[ -n "$key" ]] || { echo "NexControl Agent key is empty" >&2; exit 1; }

autostart="$(env_value "$agent_env" NEXCONTROL_AGENT_AUTOSTART_NEXACCOUNT | tr '[:upper:]' '[:lower:]')"
case "$autostart" in
  0|false|no|off) ;;
  *)
    echo "Refusing activation: NEXCONTROL_AGENT_AUTOSTART_NEXACCOUNT must be false on the VPS" >&2
    exit 1
    ;;
esac

for unit in nex-restart-dispatcher.path nexcontrol-agent.service; do
  systemctl cat "$unit" >/dev/null 2>&1 || {
    echo "Missing systemd unit: $unit" >&2
    exit 1
  }
done

systemctl enable --now nex-restart-dispatcher.path
systemctl enable --now nexcontrol-agent.service

for _ in $(seq 1 15); do
  if systemctl is-active --quiet nexcontrol-agent.service; then
    sleep 2
    if systemctl is-active --quiet nexcontrol-agent.service; then
      echo "NexControl Agent is active."
      echo "Restart dispatcher is $(systemctl is-active nex-restart-dispatcher.path 2>/dev/null || true)."
      echo "Verify the new Agent heartbeat in NexControl before starting any Telegram session-bearing runtime."
      exit 0
    fi
  fi
  sleep 1
done

echo "NexControl Agent failed to remain active." >&2
journalctl -u nexcontrol-agent.service -n 40 --no-pager >&2 || true
exit 1
