import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  access,
  readFile
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import {
  createNexusBridgeHandler
} from '../nexus-bridge/receiver.mjs';
import {
  loadNexusAdapters
} from '../nexus-bridge/adapter-loader.mjs';
import {
  serveRemoteMedia,
  mediaRegistryStats
} from '../nexus-bridge/media-registry.mjs';
import {
  classifyPublicPath
} from './routing.mjs';

const root = path.resolve(
  process.env.NEXUS_ROOT ||
  process.cwd()
);

process.env.NEXUS_ROOT = root;

const publicPort = Number(
  process.env.PORT ||
  process.env.SERVER_PORT ||
  10000
);

const telegramPort = Number(
  process.env.NEXUS_TELEGRAM_INTERNAL_PORT ||
  publicPort + 1
);

const metaPort = Number(
  process.env.NEXMETA_INTERNAL_PORT ||
  publicPort + 2
);

const browserDebugPort = Number(
  process.env.NEXMETA_BROWSER_DEBUG_PORT ||
  9223
);

const pageWorkerEnabled = !/^(?:0|false|no|off)$/i.test(
  String(process.env.NEXMETA_PAGE_WORKER_ENABLED ?? '1')
);

const pageWorkerStateFile = path.resolve(
  process.env.NEXMETA_PAGE_STATE_FILE ||
  path.join(root, '.nexmeta-state', 'page-worker-state.json')
);

const pageWorkerHealthFile = path.resolve(
  process.env.NEXMETA_PAGE_HEALTH_FILE ||
  path.join(root, '.nexmeta-state', 'page-worker-health.json')
);

const publicBaseUrl = String(
  process.env.NEXUS_PUBLIC_BASE_URL ||
  process.env.NEXMETA_PUBLIC_BASE_URL ||
  ''
).trim().replace(/\/+$/, '');

const configuredBridgeKey = String(
  process.env.NEXUS_COMMAND_GATEWAY_KEY || ''
).trim();

const bridgeKey = configuredBridgeKey ||
  crypto.randomBytes(32).toString('hex');

process.env.NEXUS_COMMAND_GATEWAY_KEY = bridgeKey;

function validPort(value) {
  return (
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65535
  );
}

for (const [name, value] of [
  ['PORT', publicPort],
  ['NEXUS_TELEGRAM_INTERNAL_PORT', telegramPort],
  ['NEXMETA_INTERNAL_PORT', metaPort],
  ['NEXMETA_BROWSER_DEBUG_PORT', browserDebugPort]
]) {
  if (!validPort(value)) {
    throw new Error(`${name} must be a valid TCP port`);
  }
}

if (
  new Set([
    publicPort,
    telegramPort,
    metaPort,
    browserDebugPort
  ]).size !== 4
) {
  throw new Error(
    'public, Telegram, NexMeta and browser debug ports must be different'
  );
}

async function requireFile(file, label) {
  try {
    await access(file);
  } catch {
    throw new Error(
      `${label} missing: ${file}`
    );
  }
}

await requireFile(
  path.join(root, 'scripts/orchestrator.mjs'),
  'Telegram orchestrator'
);

let nexmetaAvailable = true;
let nexmetaUnavailableReason = null;

for (const [file, label] of [
  [
    path.join(root, 'nexmeta/src/server.mjs'),
    'NexMeta server'
  ],
  [
    path.join(
      root,
      'nexmeta/node_modules/mongodb/package.json'
    ),
    'NexMeta MongoDB dependency'
  ]
]) {
  try {
    await access(file);
  } catch {
    nexmetaAvailable = false;
    nexmetaUnavailableReason = `${label} missing: ${file}`;
    console.error(
      '[Pterodactyl] NexMeta disabled for this boot:',
      nexmetaUnavailableReason
    );
    break;
  }
}

const adapterDirectory = path.resolve(
  process.env.NEXUS_ADAPTER_DIR ||
  path.join(root, 'nexus-bridge/adapters')
);

const adapterState = await loadNexusAdapters({
  directory: adapterDirectory
});

let discovery = null;

try {
  discovery = JSON.parse(
    await readFile(
      process.env.NEXUS_BRIDGE_DISCOVERY_FILE ||
      path.join(
        root,
        'nexus-bridge/discovery.json'
      ),
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
    Number(
      process.env.NEXUS_BRIDGE_DEDUP_TTL_MS ||
      600_000
    )
  )
);

function pruneSeenEvents(current = Date.now()) {
  for (const [key, expiresAt] of seenEvents) {
    if (expiresAt <= current) {
      seenEvents.delete(key);
    }
  }
}

async function claimEvent({
  eventId,
  source
}) {
  pruneSeenEvents();

  const key = [
    source?.platform || 'unknown',
    source?.pageId || 'no-page',
    eventId
  ].join(':');

  if (seenEvents.has(key)) {
    return false;
  }

  seenEvents.set(
    key,
    Date.now() + dedupTtlMs
  );

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
    whisper: 'nexwhisper',
    group: 'nexgroup',
    channel: 'nexcanal',
    page_event: 'nexcanal',
    assistant: 'nexai'
  };

  const preferred = byIntent[intent];

  if (
    preferred &&
    adapterState.services[preferred]
  ) {
    return preferred;
  }

  if (adapterState.services.nexai) {
    return 'nexai';
  }

  return 'auto';
}

const bridge = createNexusBridgeHandler({
  sharedKey: bridgeKey,
  services: adapterState.services,
  serviceStatus: adapterState.status,
  resolveAuto: autoService,
  claimEvent,
  releaseEvent
});

const children = new Map();
let shuttingDown = false;

function childState(label) {
  if (!children.has(label)) {
    children.set(label, {
      process: null,
      pid: null,
      startedAt: null,
      lastExit: null,
      restartCount: 0,
      recentCrashes: []
    });
  }

  return children.get(label);
}

function registerCrash(state) {
  const current = Date.now();

  state.recentCrashes = [
    ...state.recentCrashes,
    current
  ].filter(
    timestamp =>
      current - timestamp < 120_000
  );

  return state.recentCrashes.length;
}

function spawnManaged({
  label,
  script,
  env
}) {
  const state = childState(label);

  if (shuttingDown) return;

  const child = spawn(
    process.execPath,
    [script],
    {
      cwd: root,
      env: {
        ...process.env,
        ...env
      },
      stdio: 'inherit'
    }
  );

  state.process = child;
  state.pid = child.pid;
  state.startedAt = new Date();
  state.restartCount += 1;

  console.log(
    `[Pterodactyl] started ${label}`,
    {
      pid: child.pid,
      script
    }
  );

  child.once('exit', (code, signal) => {
    state.process = null;
    state.pid = null;
    state.lastExit = {
      code,
      signal,
      at: new Date()
    };

    if (shuttingDown) return;

    const crashes = registerCrash(state);

    console.error(
      `[Pterodactyl] ${label} exited`,
      {
        code,
        signal,
        crashesIn2m: crashes
      }
    );

    if (crashes >= 6) {
      console.error(
        `[Pterodactyl] ${label} is crash-looping; terminating supervisor`
      );

      shutdown('SIGTERM', 1);
      return;
    }

    const delay = Math.min(
      30_000,
      1000 * 2 ** Math.min(
        crashes - 1,
        5
      )
    );

    setTimeout(() => {
      spawnManaged({
        label,
        script,
        env
      });
    }, delay).unref();
  });
}

const telegramScript = path.join(
  root,
  'scripts/orchestrator.mjs'
);

const metaScript = path.join(
  root,
  'nexmeta/src/server.mjs'
);

const pageWorkerScript = path.join(
  root,
  'nexmeta/src/page-worker.mjs'
);

function startChildren() {
  spawnManaged({
    label: 'telegram',
    script: telegramScript,
    env: {
      PORT: String(telegramPort),
      NEXUS_ROOT: root
    }
  });

  if (nexmetaAvailable) {
    spawnManaged({
      label: 'nexmeta',
      script: metaScript,
      env: {
      PORT: String(metaPort),
      NEXUS_ROOT: root,
      NEXMETA_PUBLIC_BASE_URL:
        publicBaseUrl ||
        process.env.NEXMETA_PUBLIC_BASE_URL ||
        '',
      NEXMETA_OAUTH_REDIRECT_URI:
        process.env.NEXMETA_OAUTH_REDIRECT_URI ||
        (
          publicBaseUrl
            ? `${publicBaseUrl}/oauth/meta/callback`
            : ''
        ),
      NEXUS_COMMAND_GATEWAY_URL:
        `http://127.0.0.1:${publicPort}/internal/nexus/events`,
      NEXUS_COMMAND_GATEWAY_KEY:
        bridgeKey,
      NEXMETA_BROWSER_DEBUG_PORT:
        String(browserDebugPort),
      NEXMETA_BROWSER_DEBUG_URL:
        `http://127.0.0.1:${browserDebugPort}`,
      NEXMETA_PAGE_STATE_FILE:
        pageWorkerStateFile,
      NEXMETA_PAGE_HEALTH_FILE:
        pageWorkerHealthFile
      }
    });

    if (pageWorkerEnabled) {
      spawnManaged({
        label: 'nexmeta-page-worker',
        script: pageWorkerScript,
        env: {
          NEXUS_ROOT: root,
          NEXMETA_BROWSER_DEBUG_URL:
            `http://127.0.0.1:${browserDebugPort}`,
          NEXMETA_PAGE_STATE_FILE:
            pageWorkerStateFile,
          NEXMETA_PAGE_HEALTH_FILE:
            pageWorkerHealthFile,
          NEXUS_COMMAND_GATEWAY_URL:
            `http://127.0.0.1:${publicPort}/internal/nexus/events`,
          NEXUS_COMMAND_GATEWAY_KEY:
            bridgeKey
        }
      });
    }
  }
}

function proxyRequest(
  targetPort,
  req,
  res,
  {
    rewritePath
  } = {}
) {
  const targetPath =
    rewritePath ||
    req.url ||
    '/';

  const headers = {
    ...req.headers,
    host: `127.0.0.1:${targetPort}`,
    'x-forwarded-host':
      req.headers.host || '',
    'x-forwarded-proto':
      String(
        req.headers['x-forwarded-proto'] ||
        (
          publicBaseUrl.startsWith('https://')
            ? 'https'
            : 'http'
        )
      ),
    'x-nexus-pterodactyl-gateway': '1'
  };

  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: targetPath,
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
    console.error(
      '[Pterodactyl] proxy error',
      {
        targetPort,
        error: error?.message
      }
    );

    if (res.headersSent) {
      res.destroy(error);
      return;
    }

    res.statusCode = 502;
    res.setHeader(
      'content-type',
      'application/json; charset=utf-8'
    );

    res.end(
      JSON.stringify({
        error: 'internal_service_unavailable'
      })
    );
  });

  req.pipe(upstream);
}

async function fetchLocalHealth(
  port,
  pathName = '/health'
) {
  const startedAt = Date.now();

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}${pathName}`,
      {
        signal: AbortSignal.timeout(3000)
      }
    );

    const text = await response.text();
    let body;

    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {
        text: text.slice(0, 500)
      };
    }

    return {
      ok: response.ok,
      status: response.status,
      latencyMs:
        Date.now() - startedAt,
      body
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs:
        Date.now() - startedAt,
      error: String(
        error?.message || error
      ).slice(0, 200)
    };
  }
}

function safeChildStatus(label) {
  const state = childState(label);

  return {
    pid: state.pid,
    running:
      Boolean(state.process),
    startedAt:
      state.startedAt,
    lastExit:
      state.lastExit,
    restartCount:
      state.restartCount
  };
}

async function readPageWorkerHealth() {
  const processState = safeChildStatus('nexmeta-page-worker');

  if (!pageWorkerEnabled) {
    return {
      enabled: false,
      ok: true,
      process: processState
    };
  }

  try {
    const payload = JSON.parse(
      await readFile(pageWorkerHealthFile, 'utf8')
    );

    const observedAt = Date.parse(
      String(payload?.observedAt || '')
    );

    const fresh =
      Number.isFinite(observedAt) &&
      Date.now() - observedAt <= 90_000;

    return {
      enabled: true,
      ok:
        processState.running === true &&
        fresh &&
        payload?.loggedIn === true &&
        payload?.lastCycleOk === true,
      fresh,
      process: processState,
      health: payload
    };
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      fresh: false,
      process: processState,
      error: String(
        error?.message || error
      ).slice(0, 200)
    };
  }
}

function bridgeAuthorized(req) {
  const authorization = String(
    req.headers.authorization || ''
  );

  const supplied = authorization
    .replace(/^Bearer\s+/i, '')
    .trim();

  const left = Buffer.from(supplied);
  const right = Buffer.from(bridgeKey);

  return (
    left.length === right.length &&
    crypto.timingSafeEqual(
      left,
      right
    )
  );
}

const server = http.createServer(
  async (req, res) => {
    try {
      const url = new URL(
        req.url || '/',
        'http://nexus.local'
      );

      const route = classifyPublicPath(
        url.pathname
      );

      if (route === 'media') {
        const token = url.pathname
          .slice('/nexus-media/'.length)
          .trim();

        return serveRemoteMedia(
          req,
          res,
          token
        );
      }

      if (route === 'bridge-events') {
        return bridge(req, res);
      }

      if (route === 'bridge-status') {
        if (!bridgeAuthorized(req)) {
          res.statusCode = 401;
          res.setHeader(
            'content-type',
            'application/json; charset=utf-8'
          );
          res.end(
            JSON.stringify({
              error: 'unauthorized'
            })
          );
          return;
        }

        res.statusCode = 200;
        res.setHeader(
          'content-type',
          'application/json; charset=utf-8'
        );
        res.setHeader(
          'cache-control',
          'no-store'
        );

        res.end(
          JSON.stringify({
            ok: true,
            runtime: 'pterodactyl',
            publicPort,
            telegramPort,
            metaPort,
            persistentBridgeKey:
              Boolean(
                configuredBridgeKey
              ),
            nexmetaAvailable,
            nexmetaUnavailableReason,
            children: {
              telegram:
                safeChildStatus(
                  'telegram'
                ),
              nexmeta:
                safeChildStatus(
                  'nexmeta'
                ),
              pageWorker:
                safeChildStatus(
                  'nexmeta-page-worker'
                )
            },
            adapters:
              adapterState.status,
            mediaRegistry:
              mediaRegistryStats(),
            discovery
          })
        );

        return;
      }

      if (route === 'health-all') {
        const [
          telegram,
          nexmeta,
          pageWorker
        ] = await Promise.all([
          fetchLocalHealth(
            telegramPort,
            '/health'
          ),
          fetchLocalHealth(
            metaPort,
            '/health'
          ),
          readPageWorkerHealth()
        ]);

        const ok =
          telegram.ok &&
          (
            nexmetaAvailable
              ? nexmeta.ok
              : false
          ) &&
          pageWorker.ok;

        res.statusCode =
          ok ? 200 : 503;

        res.setHeader(
          'content-type',
          'application/json; charset=utf-8'
        );
        res.setHeader(
          'cache-control',
          'no-store'
        );

        res.end(
          JSON.stringify({
            ok,
            runtime:
              'pterodactyl',
            publicBaseUrl:
              publicBaseUrl ||
              null,
            telegram,
            nexmetaAvailable,
            nexmetaUnavailableReason,
            nexmeta,
            pageWorker,
            adapters:
              adapterState.status
          })
        );

        return;
      }

      if (
        (
          route === 'meta-health' ||
          route === 'nexmeta'
        ) &&
        !nexmetaAvailable
      ) {
        res.statusCode = 503;
        res.setHeader(
          'content-type',
          'application/json; charset=utf-8'
        );
        res.setHeader(
          'cache-control',
          'no-store'
        );
        res.end(
          JSON.stringify({
            error: 'nexmeta_unavailable',
            reason:
              nexmetaUnavailableReason
          })
        );
        return;
      }

      if (route === 'meta-health') {
        return proxyRequest(
          metaPort,
          req,
          res,
          {
            rewritePath:
              '/health'
          }
        );
      }

      if (route === 'nexmeta') {
        return proxyRequest(
          metaPort,
          req,
          res
        );
      }

      return proxyRequest(
        telegramPort,
        req,
        res
      );
    } catch (error) {
      console.error(
        '[Pterodactyl] gateway error',
        error
      );

      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader(
          'content-type',
          'application/json; charset=utf-8'
        );

        res.end(
          JSON.stringify({
            error:
              'gateway_error'
          })
        );
      } else {
        res.end();
      }
    }
  }
);

server.listen(
  publicPort,
  '0.0.0.0',
  () => {
    startChildren();

    console.log(
      '[Pterodactyl] Nexus gateway online',
      {
        publicPort,
        telegramPort,
        metaPort,
        publicBaseUrl:
          publicBaseUrl ||
          null,
        oauthCallback:
          publicBaseUrl
            ? `${publicBaseUrl}/oauth/meta/callback`
            : null,
        webhook:
          publicBaseUrl
            ? `${publicBaseUrl}/webhooks/meta`
            : null,
        ownerConnect:
          publicBaseUrl
            ? `${publicBaseUrl}/connect/meta`
            : null,
        bridgeKey:
          configuredBridgeKey
            ? 'persistent'
            : 'ephemeral'
      }
    );
  }
);

function shutdown(
  signal = 'SIGTERM',
  exitCode = 0
) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(
    '[Pterodactyl] shutting down',
    {
      signal,
      exitCode
    }
  );

  server.close();

  for (const state of children.values()) {
    if (state.process) {
      state.process.kill(signal);
    }
  }

  setTimeout(() => {
    for (
      const state
      of children.values()
    ) {
      if (state.process) {
        state.process.kill(
          'SIGKILL'
        );
      }
    }

    process.exit(exitCode);
  }, 10_000).unref();
}

process.once(
  'SIGTERM',
  () => shutdown('SIGTERM')
);

process.once(
  'SIGINT',
  () => shutdown('SIGINT')
);
