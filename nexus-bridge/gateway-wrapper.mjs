import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import {
  createNexusBridgeHandler
} from './receiver.mjs';
import {
  loadNexusAdapters
} from './adapter-loader.mjs';
import {
  serveRemoteMedia,
  mediaRegistryStats
} from './media-registry.mjs';

const outerPort = Number(process.env.PORT || 10000);
const innerPort = Number(
  process.env.NEXUS_INNER_GATEWAY_PORT ||
  (outerPort === 65535 ? 65534 : outerPort + 1)
);

const sharedKey = String(
  process.env.NEXUS_COMMAND_GATEWAY_KEY || ''
).trim();

if (!Number.isInteger(outerPort) || outerPort < 1 || outerPort > 65535) {
  throw new Error('PORT must be a valid TCP port');
}

if (!Number.isInteger(innerPort) || innerPort < 1 || innerPort > 65535) {
  throw new Error('NEXUS_INNER_GATEWAY_PORT must be a valid TCP port');
}

if (innerPort === outerPort) {
  throw new Error('NEXUS_INNER_GATEWAY_PORT must differ from PORT');
}

const adapterState = await loadNexusAdapters({
  directory:
    process.env.NEXUS_ADAPTER_DIR ||
    '/app/nexus-bridge/adapters'
});

let discovery = null;

try {
  discovery = JSON.parse(
    await readFile(
      process.env.NEXUS_BRIDGE_DISCOVERY_FILE ||
      '/app/nexus-bridge/discovery.json',
      'utf8'
    )
  );
} catch {
  discovery = null;
}

const seenEvents = new Map();
const dedupTtlMs = Math.max(
  60_000,
  Math.min(
    86_400_000,
    Number(process.env.NEXUS_BRIDGE_DEDUP_TTL_MS || 600_000)
  )
);

function pruneSeenEvents(now = Date.now()) {
  for (const [key, expiresAt] of seenEvents) {
    if (expiresAt <= now) seenEvents.delete(key);
  }
}

async function claimEvent({ eventId, source }) {
  pruneSeenEvents();

  const key = [
    source?.platform || 'unknown',
    source?.pageId || 'no-page',
    eventId
  ].join(':');

  if (seenEvents.has(key)) return false;

  seenEvents.set(key, Date.now() + dedupTtlMs);
  return key;
}

async function releaseEvent(key) {
  if (key) seenEvents.delete(key);
}

function autoService(envelope) {
  const intent = String(
    envelope?.routing?.intent || ''
  ).toLowerCase();

  const byIntent = {
    download: 'nexdownloader',
    game: 'nexgame',
    sticker: 'nexstick',
    group: 'nexgroup',
    channel: 'nexcanal',
    page_event: 'nexcanal',
    assistant: 'nexai'
  };

  const candidate = byIntent[intent];

  if (candidate && adapterState.services[candidate]) {
    return candidate;
  }

  if (adapterState.services.nexai) return 'nexai';

  return 'auto';
}

const bridge = createNexusBridgeHandler({
  sharedKey,
  services: adapterState.services,
  serviceStatus: adapterState.status,
  resolveAuto: autoService,
  claimEvent,
  releaseEvent
});

const child = spawn(
  process.execPath,
  ['/app/scripts/orchestrator.mjs'],
  {
    cwd: '/app',
    env: {
      ...process.env,
      PORT: String(innerPort),
      NEXUS_INNER_GATEWAY_PORT: String(innerPort)
    },
    stdio: 'inherit'
  }
);

let childExited = false;

child.once('exit', (code, signal) => {
  childExited = true;
  console.error(
    '[nexus-bridge] inner orchestrator exited',
    { code, signal }
  );

  setTimeout(() => {
    process.exit(
      Number.isInteger(code) && code !== 0
        ? code
        : 1
    );
  }, 50).unref();
});

function proxy(req, res) {
  if (childExited) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      error: 'inner_gateway_unavailable'
    }));
    return;
  }

  const headers = {
    ...req.headers,
    host: `127.0.0.1:${innerPort}`,
    'x-forwarded-host': req.headers.host || '',
    'x-forwarded-proto':
      String(req.headers['x-forwarded-proto'] || 'https'),
    'x-nexus-bridge-proxy': '1'
  };

  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: innerPort,
      method: req.method,
      path: req.url,
      headers
    },
    upstreamRes => {
      res.writeHead(
        upstreamRes.statusCode || 502,
        upstreamRes.headers
      );
      upstreamRes.pipe(res);
    }
  );

  upstream.on('error', error => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }

    res.statusCode = 502;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      error: 'inner_gateway_proxy_error'
    }));
  });

  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url || '/',
    'http://nexus-bridge.local'
  );

  if (url.pathname.startsWith('/nexus-media/')) {
    const token = url.pathname
      .slice('/nexus-media/'.length)
      .trim();

    return serveRemoteMedia(req, res, token);
  }

  if (url.pathname === '/internal/nexus/events') {
    if (!sharedKey) {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        error: 'bridge_key_missing'
      }));
      return;
    }

    return bridge(req, res);
  }

  if (url.pathname === '/internal/nexus/bridge-status') {
    const authorization = String(req.headers.authorization || '');
    const suppliedKey = authorization.replace(/^Bearer\s+/i, '').trim();

    const left = Buffer.from(suppliedKey);
    const right = Buffer.from(sharedKey);
    const authorized =
      Boolean(sharedKey) &&
      left.length === right.length &&
      crypto.timingSafeEqual(left, right);

    if (!authorized) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({
        error: 'unauthorized'
      }));
      return;
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({
      ok: true,
      proxy: true,
      childExited,
      outerPort,
      innerPort,
      adapters: adapterState.status,
      mediaRegistry: mediaRegistryStats(),
      discovery: discovery
        ? {
            generatedAt: discovery.generatedAt || null,
            orchestrator:
              discovery.orchestrator &&
              typeof discovery.orchestrator === 'object'
                ? discovery.orchestrator
                : null,
            bots: Array.isArray(discovery.bots)
              ? discovery.bots.map(bot => ({
                  name: bot.name,
                  present: bot.present === true,
                  package: bot.package || null,
                  scannedFiles: bot.scannedFiles || 0,
                  candidates: Array.isArray(bot.candidates)
                    ? bot.candidates.slice(0, 20)
                    : []
                }))
              : []
          }
        : null
    }));
    return;
  }

  return proxy(req, res);
});

server.listen(outerPort, '0.0.0.0', () => {
  console.log(
    '[nexus-bridge] front proxy listening',
    {
      outerPort,
      innerPort,
      loadedAdapters: Object.keys(adapterState.services)
    }
  );
});

function shutdown(signal) {
  console.log('[nexus-bridge] shutting down', signal);

  server.close(() => {
    if (!childExited) child.kill(signal);
  });

  setTimeout(() => {
    if (!childExited) child.kill('SIGKILL');
    process.exit(0);
  }, 10_000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
