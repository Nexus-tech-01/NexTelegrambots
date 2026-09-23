#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "bootstrap.sh must run as root" >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This bootstrap currently supports Debian/Ubuntu hosts (apt-get required)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git jq rsync unzip xz-utils age \
  python3 python3-pip python3-venv \
  ffmpeg procps lsof
rm -rf /var/lib/apt/lists/*

if ! getent group nex >/dev/null; then
  groupadd --system nex
fi
if ! id -u nex >/dev/null 2>&1; then
  useradd --system --gid nex --home-dir /var/lib/nex --create-home --shell /usr/sbin/nologin nex
fi

install -d -o root -g nex -m 0755 /opt/nex
install -d -o nex -g nex -m 0755 /opt/nex/current /opt/nex/releases /opt/nex/scripts
install -d -o nex -g nex -m 0750 \
  /var/lib/nex/data \
  /var/lib/nex/sessions \
  /var/lib/nex/runtime \
  /var/lib/nex/recovery \
  /var/lib/nex/downloads \
  /var/lib/nex/cache \
  /var/lib/nex/logs
install -d -o root -g nex -m 0750 /etc/nex /etc/nex/env /etc/nex/secrets
install -d -o root -g root -m 0750 /etc/nex/restart-targets.d
install -d -o root -g nex -m 0750 /backups/nex
install -d -o nex -g nex -m 0750 /backups/nex/nexcontrol-agent
install -d -o root -g root -m 0700 /backups/nex/staging

# Runtime/control directories used by NexControl Agent and watchdog.
install -d -o nex -g nex -m 0750 \
  /var/lib/nex/runtime/nexcontrol/backups \
  /var/lib/nex/runtime/nexcontrol/tmp \
  /var/lib/nex/runtime/nexcontrol/control
install -d -o root -g root -m 0700 \
  /var/lib/nex/runtime/nexcontrol/restart-history

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
fi

cat <<EOF
Nexus VPS base bootstrap complete.

Node.js major detected: ${node_major}
Required target: Node.js 22+
Application root: /opt/nex/current
Persistent state: /var/lib/nex
Environment/secrets: /etc/nex
Backups: /backups/nex
Encrypted backup tool: $(command -v age || echo missing)
EOF

if (( node_major < 22 )); then
  cat >&2 <<'EOF'

WARNING: Node.js 22+ is not installed yet.
Install Node.js 22 from the VPS provider's trusted package source or the official Node.js distribution, then run validate-host.sh.
The bootstrap deliberately does not pipe a remote installer into a root shell.
EOF
fi
