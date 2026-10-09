#!/usr/bin/env bash
# Repair NexControl supervision connectivity. No bot, Telegram session or VPS power actions.
set -Eeuo pipefail

if (( EUID != 0 )); then
  echo "Run as root on the VPS that hosts NexControl agents." >&2
  exit 2
fi

CONTROL_A="https://nexcontrol-ochre.vercel.app"
CONTROL_B="https://nexcontrol-render.vercel.app"
CHECK_URL="${CONTROL_A}/api/v1/agent/jobs/claim"
CHECK_CODE="$(curl -sS -L --max-time 20 -o /dev/null -w '%{http_code}' "${CHECK_URL}" || true)"
if [[ "${CHECK_CODE}" != 405 ]]; then
  echo "Agent API is not responding as expected (HTTP ${CHECK_CODE}); no local services changed." >&2
  exit 1
fi

has_unit() {
  [[ "$(systemctl show -p LoadState --value "$1" 2>/dev/null)" == "loaded" ]]
}

updated=()
for service in nexcontrol-agent.service nexcontrol-fleet.service; do
  if ! has_unit "${service}"; then continue; fi
  dropin="/etc/systemd/system/${service}.d"
  mkdir -p "${dropin}"
  cat >"${dropin}/80-direct-control-plane.conf" <<EOF
[Service]
Environment="NEXCONTROL_URLS=${CONTROL_A} ${CONTROL_B}"
Environment="NEXCONTROL_PRIMARY_REPROBE_MS=300000"
EOF
  updated+=("${service}")
done

if (( ${#updated[@]} )); then systemctl daemon-reload; fi
for service in "${updated[@]}"; do
  echo "Restarting supervision agent: ${service}"
  systemctl reset-failed "${service}" 2>/dev/null || true
  systemctl restart "${service}"
  systemctl --no-pager --full is-active "${service}" || true
done

if has_unit nexforge-host-agent.service; then
  echo "Restarting VPS heartbeat agent (no bots touched)"
  systemctl reset-failed nexforge-host-agent.service 2>/dev/null || true
  systemctl restart nexforge-host-agent.service
  systemctl --no-pager --full is-active nexforge-host-agent.service || true
fi
echo "NexControl agent recovery attempted. Check new heartbeats in NexControl."
