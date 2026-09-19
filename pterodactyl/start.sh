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
  npm --prefix nexmeta install --omit=dev --no-audit --no-fund
fi

node --check pterodactyl/start.mjs
node --check nexmeta/src/server.mjs
node --check nexus-bridge/receiver.mjs
node --check nexus-bridge/adapter-loader.mjs
node --check nexus-bridge/media-registry.mjs

exec node pterodactyl/start.mjs
