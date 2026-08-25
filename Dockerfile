FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip xz-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Healthy runtime rebuilt from the five original bot ZIP archives.
# Every part is an independently base64-encoded binary slice. Decode in
# lexical order, concatenate the binary slices, then verify the exact archive.
COPY runtime-src.b64.part-* /tmp/
RUN set -eux; \
    test "$(find /tmp -maxdepth 1 -name 'runtime-src.b64.part-*' | wc -l)" -eq 58; \
    : > /tmp/nexus-bots-src.tar.xz; \
    for f in $(printf '%s\n' /tmp/runtime-src.b64.part-* | sort); do \
      base64 -d "$f" >> /tmp/nexus-bots-src.tar.xz; \
    done; \
    echo "3272a12b20c8d1d75519c8db728ab76d4c09c2c6541611acedabb7f093a69946  /tmp/nexus-bots-src.tar.xz" | sha256sum -c -; \
    xz -t /tmp/nexus-bots-src.tar.xz; \
    tar -xJf /tmp/nexus-bots-src.tar.xz -C /app; \
    test -f /app/scripts/orchestrator.mjs; \
    test -f /app/scripts/preflight.mjs; \
    test -f /app/scripts/install-all.mjs; \
    test -f /app/scripts/build-all.mjs; \
    test -f /app/bots/nexdownloader/requirements.txt; \
    for bot in nexgame nexcanal nexdownloader nexgroup nexstick; do test -f "/app/bots/$bot/package.json"; done; \
    rm -f /tmp/runtime-src.b64.part-* /tmp/nexus-bots-src.tar.xz

# Runtime secrets are supplied only by Render environment variables.
# No repository .env is copied into the image.
RUN python3 -m pip install --break-system-packages --no-cache-dir -r bots/nexdownloader/requirements.txt
RUN node scripts/install-all.mjs \
 && node scripts/build-all.mjs

EXPOSE 10000

CMD ["sh", "-c", "if [ -z \"${NEXUS_PUBLIC_BASE_URL:-}\" ] && [ -n \"${RENDER_EXTERNAL_HOSTNAME:-}\" ]; then export NEXUS_PUBLIC_BASE_URL=\"https://${RENDER_EXTERNAL_HOSTNAME}\"; fi; node scripts/preflight.mjs && exec node scripts/orchestrator.mjs"]
