#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "rollback-nexaccount-cutover.sh must run as root" >&2
  exit 1
fi

mapfile -t units < <(
  {
    systemctl list-units --type=service --all --no-legend 'nexaccount@*.service' 2>/dev/null | awk '{print $1}'
    systemctl list-unit-files --type=service --no-legend 'nexaccount@*.service' 2>/dev/null | awk '{print $1}'
  } | grep -E '^nexaccount@[0-9]+\.service$' | sort -u
)

if (( ${#units[@]} == 0 )); then
  echo "No NexAccount systemd instances found on this VPS."
else
  echo "Stopping/disabling VPS NexAccount instances: ${units[*]}"
  for unit in "${units[@]}"; do
    systemctl disable --now "$unit" || true
  done
fi

sleep 2
still="$(systemctl list-units --type=service --state=active --no-legend 'nexaccount@*.service' 2>/dev/null | awk '{print $1}' | paste -sd, -)"
if [[ -n "$still" ]]; then
  echo "Rollback incomplete; active VPS workers remain: $still" >&2
  exit 1
fi

echo
echo "VPS NexAccount workers are stopped."
echo "This script does NOT start the old host."
echo "Only restart the old host after confirming the VPS sessions are disconnected/stopped and any runtime lease has expired or been released."
