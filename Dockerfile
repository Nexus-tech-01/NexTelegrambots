FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip xz-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Canonical NexusBots v1.2.0 Render source bundle.
# The base64 files are contiguous chunks of one encoded xz archive, so they
# must be concatenated first and decoded once.
COPY render-src.b64.part-* /tmp/
RUN set -eux; \
    test "$(find /tmp -maxdepth 1 -name 'render-src.b64.part-*' | wc -l)" -eq 9; \
    cat /tmp/render-src.b64.part-* | base64 -d > /tmp/nexus-bots.tar.xz; \
    xz -t /tmp/nexus-bots.tar.xz; \
    tar -xJf /tmp/nexus-bots.tar.xz -C /app; \
    test -f /app/scripts/orchestrator.mjs; \
    test -f /app/scripts/preflight.mjs; \
    test -f /app/scripts/install-all.mjs; \
    test -f /app/scripts/build-all.mjs; \
    test -f /app/bots/nexdownloader/requirements.txt; \
    rm -f /tmp/render-src.b64.part-* /tmp/nexus-bots.tar.xz

# Private deployment environment. Render runtime environment variables can
# override these values without changing the image.
COPY .env /app/.env

RUN python3 -m pip install --break-system-packages --no-cache-dir -r bots/nexdownloader/requirements.txt
RUN node scripts/install-all.mjs && node scripts/build-all.mjs

EXPOSE 10000

CMD ["sh", "-c", "if [ -z \"${NEXUS_PUBLIC_BASE_URL:-}\" ] && [ -n \"${RENDER_EXTERNAL_HOSTNAME:-}\" ]; then export NEXUS_PUBLIC_BASE_URL=\"https://${RENDER_EXTERNAL_HOSTNAME}\"; fi; node scripts/preflight.mjs && exec node scripts/orchestrator.mjs"]
