#!/usr/bin/env bash
set -euo pipefail
ROOT="${NEX_ROOT:-/opt/nex/current}"
install -m 0644 "$ROOT/infra/systemd/nexguard.service" /etc/systemd/system/nexguard.service
install -m 0644 "$ROOT/infra/systemd/nex-automation-supervisor.service" /etc/systemd/system/nex-automation-supervisor.service
install -m 0644 "$ROOT/infra/systemd/nexforge-repair-bridge.service" /etc/systemd/system/nexforge-repair-bridge.service
mkdir -p /etc/nex
systemctl daemon-reload
systemctl enable --now nexguard.service nex-automation-supervisor.service
if [[ -s /etc/nex/nexguard-ai.env ]]; then
  systemctl enable --now nexforge-repair-bridge.service
else
  echo "NexForge bridge not enabled: /etc/nex/nexguard-ai.env is not configured."
fi
systemctl --no-pager --full status nexguard.service nex-automation-supervisor.service || true
