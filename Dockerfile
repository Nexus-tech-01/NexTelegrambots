FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip xz-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Canonical NexusBots v1.2.0 Render source bundle.
# Each stored part is an independently base64-encoded binary slice of the
# final xz archive. Decode every part in lexical order, then join the binary
# slices before validating and extracting the archive.
COPY render-src.b64.part-* /tmp/
RUN set -eux; \
    test "$(find /tmp -maxdepth 1 -name 'render-src.b64.part-*' | wc -l)" -eq 9; \
    : > /tmp/nexus-bots.tar.xz; \
    for f in $(printf '%s\n' /tmp/render-src.b64.part-* | sort); do \
      base64 -d "$f" >> /tmp/nexus-bots.tar.xz; \
    done; \
    xz -t /tmp/nexus-bots.tar.xz; \
    tar -xJf /tmp/nexus-bots.tar.xz -C /app; \
    test -f /app/scripts/orchestrator.mjs; \
    test -f /app/scripts/preflight.mjs; \
    test -f /app/scripts/install-all.mjs; \
    test -f /app/scripts/build-all.mjs; \
    test -f /app/bots/nexdownloader/requirements.txt; \
    for bot in nexgame nexcanal nexdownloader nexgroup nexstick; do test -d "/app/bots/$bot"; done; \
    rm -f /tmp/render-src.b64.part-* /tmp/nexus-bots.tar.xz

# NexCanal public-channel watcher runs beside the bundled bot processes.
COPY watchers /app/watchers

# Secrets are supplied only through Render environment variables.
# Never COPY a repository .env file into the image.
RUN python3 -m pip install --break-system-packages --no-cache-dir -r bots/nexdownloader/requirements.txt
RUN node scripts/install-all.mjs && node scripts/build-all.mjs
RUN cd /app/watchers && npm install --omit=dev --no-audit --no-fund

EXPOSE 10000

CMD ["sh", "-c", "if [ -z \"${NEXUS_PUBLIC_BASE_URL:-}\" ] && [ -n \"${RENDER_EXTERNAL_HOSTNAME:-}\" ]; then export NEXUS_PUBLIC_BASE_URL=\"https://${RENDER_EXTERNAL_HOSTNAME}\"; fi; if [ -n \"${NEXCANAL__WATCHER_SESSION:-}\" ]; then node watchers/liteapks-relay.mjs & fi; node scripts/preflight.mjs && exec node scripts/orchestrator.mjs"]
