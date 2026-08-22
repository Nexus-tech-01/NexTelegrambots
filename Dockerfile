FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The source is stored as compact base64 archive chunks so this private
# repository remains lightweight while Render can still build the full monorepo.
COPY nexus-bots-src.tar.gz.b64.part-* /tmp/
RUN cat /tmp/nexus-bots-src.tar.gz.b64.part-* | base64 -d | tar -xz -C /app \
 && rm -f /tmp/nexus-bots-src.tar.gz.b64.part-*

RUN python3 -m pip install --break-system-packages --no-cache-dir -r bots/nexdownloader/requirements.txt
RUN node scripts/install-all.mjs && node scripts/build-all.mjs

EXPOSE 10000
CMD ["sh", "-c", "node scripts/preflight.mjs && exec node scripts/orchestrator.mjs"]
