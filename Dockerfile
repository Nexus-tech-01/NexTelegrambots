FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip xz-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Healthy source bundle rebuilt from the five original bot ZIP archives.
# Each part is an independently base64-encoded binary slice.
COPY runtime-src.b64.part-* /tmp/
RUN set -eux; \
    test "$(find /tmp -maxdepth 1 -name 'runtime-src.b64.part-*' | wc -l)" -eq 3; \
    : > /tmp/nexus-bots-src.tar.xz; \
    for f in $(printf '%s\n' /tmp/runtime-src.b64.part-* | sort); do base64 -d "$f" >> /tmp/nexus-bots-src.tar.xz; done; \
    echo "360532e2aefc2da4f47f3dc3d69ae7cd815fa93b9753056e4d246ddb90a11973  /tmp/nexus-bots-src.tar.xz" | sha256sum -c -; \
    xz -t /tmp/nexus-bots-src.tar.xz; \
    tar -xJf /tmp/nexus-bots-src.tar.xz -C /app; \
    test -f /app/scripts/orchestrator.mjs; \
    test -f /app/scripts/preflight.mjs; \
    test -f /app/scripts/install-all.mjs; \
    test -f /app/scripts/build-all.mjs; \
    test -f /app/bots/nexdownloader/requirements.txt; \
    for bot in nexgame nexcanal nexdownloader nexgroup nexstick; do test -f "/app/bots/$bot/package.json"; done; \
    rm -f /tmp/runtime-src.b64.part-* /tmp/nexus-bots-src.tar.xz

RUN python3 -m pip install --break-system-packages --no-cache-dir -r bots/nexdownloader/requirements.txt
RUN node scripts/install-all.mjs \
 && node scripts/build-all.mjs \
 && node scripts/prune-all.mjs

EXPOSE 10000

CMD ["sh", "-c", "node scripts/preflight.mjs && exec node scripts/orchestrator.mjs"]
