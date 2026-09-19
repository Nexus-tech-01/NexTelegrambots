#!/bin/sh
set -eu

ROOT="${NEXUS_ROOT:-$(pwd)}"
cd "$ROOT"

echo "[Pterodactyl] Nexus root: $ROOT"

if [ -f scripts/preflight.mjs ]; then
  node scripts/preflight.mjs
fi

if [ ! -f nexmeta/node_modules/mongodb/package.json ]; then
  echo "[Pterodactyl] Installing NexMeta production dependencies..."
  if ! npm --prefix nexmeta install --omit=dev --no-audit --no-fund; then
    echo "[Pterodactyl] WARNING: NexMeta dependency installation failed."
    echo "[Pterodactyl] Telegram runtime will still be allowed to start."
  fi
fi

node --check pterodactyl/start.mjs
node --check nexmeta/src/server.mjs
node --check nexus-bridge/receiver.mjs
node --check nexus-bridge/adapter-loader.mjs
node --check nexus-bridge/media-registry.mjs

if [ -f nexus-bridge/discover-bot-cores.mjs ]; then
  node nexus-bridge/discover-bot-cores.mjs ||     echo "[Pterodactyl] Core discovery warning: continuing without discovery report."
fi

if ! node pterodactyl/check.mjs; then
  echo "[Pterodactyl] WARNING: NexMeta connection prerequisites are incomplete."
  echo "[Pterodactyl] Telegram runtime will still start; /connect/meta stays unavailable until configuration is fixed."
fi

exec node pterodactyl/start.mjs
