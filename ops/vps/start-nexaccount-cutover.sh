#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "start-nexaccount-cutover.sh must run as root" >&2
  exit 1
fi

if [[ "${1:-}" != "--old-host-stopped" ]]; then
  cat >&2 <<'EOF'
Refusing to start NexAccount.

First stop the matching NexAccount/MTProto session-bearing runtime on the old host.
After you have verified it is stopped, rerun:

  start-nexaccount-cutover.sh --old-host-stopped

The flag is an explicit operator assertion; this script cannot prove the remote old host is stopped.
EOF
  exit 2
fi

repo_root=/opt/nex/current
env_file=/etc/nex/env/nexaccount.env
[[ -f "$env_file" ]] || { echo "Missing $env_file" >&2; exit 1; }

worker_count="$(awk -F= '$1=="NEXACCOUNT_WORKER_COUNT"{gsub(/[[:space:]]/,"",$2);print $2}' "$env_file" | tail -1)"
worker_count="${worker_count:-1}"
if [[ "$worker_count" != "1" ]]; then
  echo "First cutover is intentionally limited to NEXACCOUNT_WORKER_COUNT=1; found $worker_count" >&2
  echo "Stabilize worker 0 first, then scale with the procedure in NEXACCOUNT_WORKERS.md." >&2
  exit 1
fi

if systemctl list-units --type=service --state=active --no-legend 'nexaccount@*.service' | grep -q .; then
  echo "A NexAccount worker is already active; refusing duplicate cutover start." >&2
  exit 1
fi

if ! systemctl is-active --quiet nexcontrol-agent.service; then
  echo "NexControl Agent is not active; activate/verify the control plane first." >&2
  exit 1
fi

if ! systemctl is-active --quiet nex-restart-dispatcher.path; then
  echo "NexControl restart dispatcher is not active." >&2
  exit 1
fi

if [[ ! -d "$repo_root/nexaccount/node_modules" ]]; then
  echo "NexAccount dependencies are not installed; run prepare-runtime.sh first." >&2
  exit 1
fi

echo "Starting NexAccount worker 0 without enabling it yet..."
systemctl start nexaccount@0.service

healthy=0
for _ in $(seq 1 30); do
  if runuser -u nex -- node "$repo_root/ops/vps/check-nexaccount-workers.mjs" 1 >/tmp/nexaccount-cutover-health.json 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  echo "NexAccount worker 0 did not become healthy. Stopping VPS worker." >&2
  systemctl stop nexaccount@0.service || true
  journalctl -u nexaccount@0.service -n 100 --no-pager >&2 || true
  rm -f /tmp/nexaccount-cutover-health.json
  exit 1
fi

cat /tmp/nexaccount-cutover-health.json
rm -f /tmp/nexaccount-cutover-health.json

systemctl enable nexaccount@0.service
echo
echo "NexAccount worker 0 is healthy and enabled for boot."
echo "Keep the old host's matching session runtime stopped."
echo "Observe logs/Telegram behavior before adding more workers."
