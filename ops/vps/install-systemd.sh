#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "install-systemd.sh must run as root" >&2
  exit 1
fi

repo_root="${1:-/opt/nex/current}"
unit_src="$repo_root/ops/vps/systemd"

for unit in \
  nexcontrol-agent.service \
  nex-resource-watchdog.service \
  nexaccount@.service \
  nex-backup.service \
  nex-backup.timer \
  nex-restart-dispatcher.service \
  nex-restart-dispatcher.path
do
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

if [[ ! -f /etc/nex/env/shared.env ]]; then
  install -o root -g nex -m 0640 "$repo_root/ops/vps/shared.env.example" /etc/nex/env/shared.env
  echo "Created /etc/nex/env/shared.env. Fill only the infrastructure values actually used."
fi

if [[ ! -f /etc/nex/env/nexaccount.env ]]; then
  install -o root -g nex -m 0640 "$repo_root/ops/vps/nexaccount.env.example" /etc/nex/env/nexaccount.env
  echo "Created /etc/nex/env/nexaccount.env. Fill NexAccount secrets before starting any worker."
fi

if [[ ! -f /etc/nex/env/backup.env ]]; then
  install -o root -g root -m 0600 "$repo_root/ops/vps/backup.env.example" /etc/nex/env/backup.env
  echo "Created /etc/nex/env/backup.env. Configure an off-host target before enabling backups."
fi

install -d -o nex -g nex -m 0750 /var/lib/nex/runtime/nexaccount
install -d -o nex -g nex -m 0750 /var/lib/nex/downloads/nexanime-tmp
install -d -o root -g nex -m 0750 /backups/nex
install -d -o nex -g nex -m 0750 /backups/nex/nexcontrol-agent
install -d -o root -g root -m 0700 /backups/nex/staging
install -d -o root -g root -m 0750 /etc/nex/restart-targets.d
install -d -o root -g root -m 0700 /var/lib/nex/runtime/nexcontrol/restart-history

# Start with an empty workload allowlist. Future recovered bot units can be added
# explicitly without granting the nex account arbitrary root/systemctl access.
if [[ ! -f /etc/nex/restart-targets.d/all.list ]]; then
  install -o root -g root -m 0640 /dev/null /etc/nex/restart-targets.d/all.list
fi

systemctl daemon-reload

cat <<'EOF'
Systemd units installed and configuration templates prepared.

Nothing was enabled or started automatically.

Deliberately NOT enabled or started:
  nexcontrol-agent.service
  nex-resource-watchdog.service
  nex-restart-dispatcher.path
  nexaccount@*.service
  nex-backup.timer

Before starting NexControl Agent:
  1. fill /etc/nex/env/nexcontrol-agent.env
  2. review /etc/nex/nexcontrol-agent.json
  3. confirm /opt/nex/current is the intended release

Then:
  systemctl enable --now nex-restart-dispatcher.path
  systemctl enable --now nexcontrol-agent
  journalctl -u nexcontrol-agent -f

Before starting NexAccount:
  1. fill /etc/nex/env/shared.env and /etc/nex/env/nexaccount.env
  2. stop the matching session-bearing runtime on the old host
  3. start worker 0 first
  4. verify it before enabling it

Example one-worker cutover:
  systemctl start nexaccount@0
  node /opt/nex/current/ops/vps/check-nexaccount-workers.mjs 1

Before enabling backups:
  1. configure /etc/nex/env/backup.env
  2. put public age recipient(s) in /etc/nex/secrets/backup-age-recipients.txt
  3. run one manual nex-backup.service
  4. restore-test that encrypted backup elsewhere
  5. only then: systemctl enable --now nex-backup.timer

Enable the resource watchdog only after runtime paths are verified:
  systemctl enable --now nex-resource-watchdog
EOF
