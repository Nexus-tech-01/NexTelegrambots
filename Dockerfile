FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip xz-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Full NexusBots v1.2.0 production source bundle.
# It contains the five bot folders plus the shared orchestrator/gateway scripts.
COPY render-src.b64.part-* /tmp/
RUN cat /tmp/render-src.b64.part-* | base64 -d > /tmp/nexus-bots.tar.xz \
 && tar -xJf /tmp/nexus-bots.tar.xz -C /app \
 && rm -f /tmp/render-src.b64.part-* /tmp/nexus-bots.tar.xz

# NexDownloader uses small Python workers in addition to Node.js/FFmpeg.
RUN python3 -m pip install --break-system-packages --no-cache-dir -r bots/nexdownloader/requirements.txt

# Install each isolated Node.js project, then build the TypeScript bots.
RUN node scripts/install-all.mjs && node scripts/build-all.mjs

EXPOSE 10000

# Render provides RENDER_EXTERNAL_HOSTNAME automatically. Convert it to the
# public HTTPS base URL expected by the Telegram webhook configuration.
CMD ["sh", "-c", "if [ -z \"${NEXUS_PUBLIC_BASE_URL:-}\" ] && [ -n \"${RENDER_EXTERNAL_HOSTNAME:-}\" ]; then export NEXUS_PUBLIC_BASE_URL=\"https://${RENDER_EXTERNAL_HOSTNAME}\"; fi; node scripts/preflight.mjs && exec node scripts/orchestrator.mjs"]
