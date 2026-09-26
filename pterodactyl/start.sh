#!/bin/sh
set -eu

ROOT="${NEXUS_ROOT:-$(pwd)}"
cd "$ROOT"

echo "[Pterodactyl] Nexus root: $ROOT"

EXTRACTED_RUNTIME=0

if [ ! -f scripts/orchestrator.mjs ]; then
  TMP_XZ="/tmp/nexus-runtime.tar.xz"
  TMP_B64="/tmp/nexus-runtime.b64"

  if ls render-src.b64.part-* >/dev/null 2>&1; then
    echo "[Pterodactyl] Reconstructing canonical Nexus runtime..."
    cat render-src.b64.part-* > "$TMP_B64"
  elif ls nexus-bots-src.tar.xz.b64.part-* >/dev/null 2>&1; then
    echo "[Pterodactyl] Reconstructing Nexus source runtime..."
    cat nexus-bots-src.tar.xz.b64.part-* > "$TMP_B64"
  else
    echo "[Pterodactyl] ERROR: Telegram runtime is missing and no source archive parts were found."
    exit 1
  fi

  if ! base64 -d "$TMP_B64" > "$TMP_XZ" 2>/dev/null; then
    if ! base64 --decode "$TMP_B64" > "$TMP_XZ" 2>/dev/null; then
      echo "[Pterodactyl] ERROR: unable to decode Nexus runtime archive."
      rm -f "$TMP_B64" "$TMP_XZ"
      exit 1
    fi
  fi

  rm -f "$TMP_B64"

  echo "[Pterodactyl] Extracting Nexus runtime without overwriting secrets/NexMeta overlay..."
  tar \
    --exclude='.env' \
    --exclude='./.env' \
    --exclude='*/.env' \
    --exclude='*/.env.*' \
    --exclude='nexmeta' \
    --exclude='./nexmeta' \
    --exclude='nexus-bridge' \
    --exclude='./nexus-bridge' \
    --exclude='pterodactyl' \
    --exclude='./pterodactyl' \
    --exclude='.git' \
    --exclude='./.git' \
    -xJf "$TMP_XZ" \
    -C "$ROOT"

  rm -f "$TMP_XZ"

  if [ ! -f scripts/orchestrator.mjs ]; then
    echo "[Pterodactyl] ERROR: extracted runtime still has no scripts/orchestrator.mjs."
    exit 1
  fi

  EXTRACTED_RUNTIME=1
fi

if [ "$EXTRACTED_RUNTIME" = "1" ]; then
  if [ -f scripts/install-all.mjs ]; then
    echo "[Pterodactyl] Installing Telegram bot dependencies from extracted runtime..."
    node scripts/install-all.mjs
  fi

  if [ -f scripts/build-all.mjs ]; then
    echo "[Pterodactyl] Building Telegram bot runtime..."
    node scripts/build-all.mjs
  fi
fi

if [ -f scripts/preflight.mjs ]; then
  node scripts/preflight.mjs
fi

if [ ! -f nexmeta/node_modules/mongodb/package.json ] || [ ! -f nexmeta/node_modules/puppeteer-core/package.json ] || [ ! -f nexmeta/node_modules/@sparticuz/chromium/package.json ]; then
  echo "[Pterodactyl] Installing NexMeta production dependencies (including persistent browser runtime)..."
  if ! npm --prefix nexmeta install --omit=dev --no-audit --no-fund; then
    echo "[Pterodactyl] WARNING: NexMeta dependency installation failed."
    echo "[Pterodactyl] Telegram runtime will still be allowed to start."
  fi
fi

node --check pterodactyl/start.mjs
node --check nexmeta/src/server.mjs
node --check nexmeta/src/session-agent.mjs
node --check nexmeta/src/page-worker.mjs
node --check nexmeta/src/page-publisher.mjs
node --check nexmeta/src/personal-watcher.mjs
node --check nexus-bridge/receiver.mjs
node --check nexus-bridge/adapter-loader.mjs
node --check nexus-bridge/media-registry.mjs

if [ -f nexus-bridge/discover-bot-cores.mjs ]; then
  node nexus-bridge/discover-bot-cores.mjs || \
    echo "[Pterodactyl] Core discovery warning: continuing without discovery report."
fi

if ! node pterodactyl/check.mjs; then
  echo "[Pterodactyl] WARNING: NexMeta connection prerequisites are incomplete."
  echo "[Pterodactyl] Telegram runtime will still start; /connect/meta stays unavailable until configuration is fixed."
fi

exec node pterodactyl/start.mjs
