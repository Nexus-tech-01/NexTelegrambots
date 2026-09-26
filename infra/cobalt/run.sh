#!/usr/bin/env bash
set -euo pipefail

IMAGE="${COBALT_IMAGE:-ghcr.io/imputnet/cobalt:11}"
NAME="${COBALT_CONTAINER:-nex-cobalt}"
PORT="${COBALT_PORT:-9000}"
API_URL="${COBALT_API_URL:-http://127.0.0.1:${PORT}/}"

docker pull "$IMAGE"
docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  --init \
  --read-only \
  --security-opt no-new-privileges=true \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  -p "127.0.0.1:${PORT}:9000/tcp" \
  -e "API_URL=${API_URL}" \
  "$IMAGE"

echo "cobalt running on 127.0.0.1:${PORT}"
