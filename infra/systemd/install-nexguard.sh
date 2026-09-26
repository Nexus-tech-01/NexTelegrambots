#!/usr/bin/env bash
set -euo pipefail
ROOT="${NEX_ROOT:-/opt/nex/current}"
install -m 0644 "$ROOT/infra/systemd/nexguard.service" /etc/systemd/system/nexguard.service
install -m 0644 "$ROOT/infra/systemd/nex-automation-supervisor.service" /etc/systemd/system/nex-automation-supervisor.service
install -m 0644 "$ROOT/infra/systemd/nexforge-repair-bridge.service" /etc/systemd/system/nexforge-repair-bridge.service
mkdir -p /etc/nex

# Register the supervision services in the local NexControl agent config when it exists.
# This only edits the service registry and preserves every existing secret/root/check.
AGENT_CONFIG="$ROOT/nexcontrol/agent/agent.config.json"
if [[ -f "$AGENT_CONFIG" ]]; then
  node - "$AGENT_CONFIG" <<'NODE'
const fs=require('fs');
const file=process.argv[2];
const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
cfg.services=cfg.services||{};
Object.assign(cfg.services,{
  nexguard:{
    unit:'nexguard.service',
    description:'NexGuard autonomous self-test and self-healing supervisor',
    actions:['start','stop','restart']
  },
  'nex-automation-supervisor':{
    unit:'nex-automation-supervisor.service',
    description:'Nexus strict cross-platform automation supervisor',
    actions:['start','stop','restart']
  },
  'nexforge-repair-bridge':{
    unit:'nexforge-repair-bridge.service',
    description:'NexGuard to NexForge shared AI repair bridge',
    actions:['start','stop','restart']
  }
});
const tmp=file+'.nexguard.tmp';
fs.writeFileSync(tmp,JSON.stringify(cfg,null,2)+'\n',{mode:0o600});
fs.renameSync(tmp,file);
NODE
fi

systemctl daemon-reload
systemctl enable --now nexguard.service nex-automation-supervisor.service
if [[ -s /etc/nex/nexguard-ai.env ]]; then
  systemctl enable --now nexforge-repair-bridge.service
else
  echo "NexForge bridge not enabled: /etc/nex/nexguard-ai.env is not configured."
fi
systemctl --no-pager --full status nexguard.service nex-automation-supervisor.service || true

# Reload NexControl so the new service registry is visible immediately.
if systemctl list-unit-files --type=service 2>/dev/null | grep -q '^nexcontrol-agent\.service'; then
  systemctl restart nexcontrol-agent.service || true
fi
