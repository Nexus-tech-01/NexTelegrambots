#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="${1:-/opt/nex/current}"
nexaccount="$repo_root/nexaccount"

if [[ ! -d "$nexaccount" ]]; then
  echo "Missing NexAccount source: $nexaccount" >&2
  exit 1
fi

for cmd in node npm; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing required command: $cmd" >&2
    exit 1
  }
done

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  echo "Node.js 22+ required; found $(node -v)" >&2
  exit 1
fi

if [[ ! -f "$nexaccount/package-lock.json" ]]; then
  echo "NexAccount package-lock.json missing; refusing non-reproducible install" >&2
  exit 1
fi

pkg_version="$(node -e "console.log(require(process.argv[1]).version)" "$nexaccount/package.json")"
lock_version="$(node -e "console.log(require(process.argv[1]).version)" "$nexaccount/package-lock.json")"
if [[ "$pkg_version" != "$lock_version" ]]; then
  echo "package.json/package-lock.json version mismatch: $pkg_version vs $lock_version" >&2
  exit 1
fi

echo "Installing NexAccount production dependencies from lockfile..."
(
  cd "$nexaccount"
  npm ci --omit=dev --no-audit --no-fund
)

echo "Running offline/static NexAccount regression checks..."
(
  cd "$nexaccount"
  npm run check
)

# The Agent itself currently has no third-party dependencies, but validate its
# entrypoint before the VPS service is allowed to start.
node --check "$repo_root/nexcontrol/agent/index.mjs"
node --check "$repo_root/nexcontrol/agent/resource-watchdog.mjs"

echo
echo "VPS directly-versioned runtime preparation passed."
echo "No bot, Telegram user session, watcher or NexAccount worker was started."
