FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip xz-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Full NexusBots production source bundle.
# Each stored part is decoded independently, then the binary pieces are joined.
# This avoids corrupting the xz stream when base64 chunks contain their own boundaries.
COPY nexus-bots-src.tar.xz.b64.part-* /tmp/
RUN set -eux; \
    : > /tmp/nexus-bots.tar.xz; \
    for f in /tmp/nexus-bots-src.tar.xz.b64.part-*; do \
      base64 -d "$f" >> /tmp/nexus-bots.tar.xz; \
    done; \
    xz -t /tmp/nexus-bots.tar.xz; \
    tar -xJf /tmp/nexus-bots.tar.xz -C /app; \
    rm -f /tmp/nexus-bots-src.tar.xz.b64.part-* /tmp/nexus-bots.tar.xz

# Private repository deployment environment.
COPY .env /app/.env

RUN python3 -m pip install --break-system-packages --no-cache-dir -r bots/nexdownloader/requirements.txt
RUN node scripts/install-all.mjs && node scripts/build-all.mjs

EXPOSE 10000

CMD ["sh", "-c", "if [ -z \"${NEXUS_PUBLIC_BASE_URL:-}\" ] && [ -n \"${RENDER_EXTERNAL_HOSTNAME:-}\" ]; then export NEXUS_PUBLIC_BASE_URL=\"https://${RENDER_EXTERNAL_HOSTNAME}\"; fi; node scripts/preflight.mjs && exec node scripts/orchestrator.mjs"]
