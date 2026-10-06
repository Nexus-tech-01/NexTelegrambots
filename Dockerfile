FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NEX_LITEAPKS_STATE_FILE=/var/data/nexcanal-watch-state-v2.json

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg gzip python3 python3-pip xz-utils \
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

# Keep the live NexAccount sticker engine on the repository version instead of
# the older snapshot embedded in the Render source archive. This makes
# Noteclone/Filitake/Ultratake performance and durability fixes deploy on every
# main-branch build without having to regenerate the whole legacy archive.
COPY nexaccount/sticker-engine.mjs /app/nexaccount/sticker-engine.mjs
COPY nexaccount/sticker-transform.mjs /app/nexaccount/sticker-transform.mjs
RUN node --check /app/nexaccount/sticker-engine.mjs \
 && node --check /app/nexaccount/sticker-transform.mjs

# NexCanal public-channel watchers run beside the bundled bot processes.
COPY watchers /app/watchers

# PID 1 supervisor keeps background automations alive and escalates crash loops
# to a full Render container restart.
COPY ops/render-supervisor.mjs /app/ops/render-supervisor.mjs

# Rehydrate and validate the intelligent anime pipeline at build time.
RUN set -eux; \
    base64 -d /app/watchers/anime-pipeline.mjs.gz.b64 | gzip -dc > /app/watchers/anime-pipeline.mjs; \
    node --check /app/watchers/anime-pipeline.mjs

# Secrets are supplied only through environment variables.
# Never COPY a repository .env file into the image.
RUN python3 -m pip install --break-system-packages --no-cache-dir -r bots/nexdownloader/requirements.txt
RUN node scripts/install-all.mjs && node scripts/build-all.mjs
RUN cd /app/watchers && npm install --omit=dev --no-audit --no-fund

EXPOSE 10000

CMD ["node", "ops/render-supervisor.mjs"]
