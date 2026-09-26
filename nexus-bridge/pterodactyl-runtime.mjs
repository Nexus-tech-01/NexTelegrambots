import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createNexusBridgeHandler } from './receiver.mjs';
import { loadNexusAdapters } from './adapter-loader.mjs';
import { serveRemoteMedia, mediaRegistryStats } from './media-registry.mjs';
import { handleRequest as handleNexMeta } from '../nexmeta/src/handler.mjs';
import { startPersonalWatcher } from '../nexmeta/src/personal-watcher.mjs';

const root = path.resolve(process.env.NEXUS_ROOT || process.cwd());
const port = Number(process.env.NEXMETA_INTERNAL_PORT || 3110);
const publicPort = Number(process.env.NEXMETA_PUBLIC_PORT || process.env.SERVER_PORT || 0);
const sharedKey = String(process.env.NEXUS_COMMAND_GATEWAY_KEY || '').trim();
const browserDebugPort = Math.max(1024, Math.min(65535, Number(process.env.NEXMETA_BROWSER_DEBUG_PORT || 9223)));
const pageWorkerEnabled = !/^(?:0|false|no|off)$/i.test(String(process.env.NEXMETA_PAGE_WORKER_ENABLED ?? '1'));
const pageWorkerStateFile = path.resolve(
  process.env.NEXMETA_PAGE_STATE_FILE ||
  path.join(root, '.nexmeta-state', 'page-worker-state.json')
);
const pageWorkerHealthFile = path.resolve(
  process.env.NEXMETA_PAGE_HEALTH_FILE ||
  path.join(root, '.nexmeta-state', 'page-worker-health.json')
);

process.env.NEXMETA_BROWSER_DEBUG_PORT = String(browserDebugPort);
process.env.NEXMETA_BROWSER_DEBUG_URL =
  process.env.NEXMETA_BROWSER_DEBUG_URL ||
  `http://127.0.0.1:${browserDebugPort}`;
process.env.NEXMETA_PAGE_STATE_FILE = pageWorkerStateFile;
process.env.NEXMETA_PAGE_HEALTH_FILE = pageWorkerHealthFile;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('NEXMETA_INTERNAL_PORT must be a valid TCP port');
}

if (
  publicPort &&
  (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535)
) {
  throw new Error('NEXMETA_PUBLIC_PORT/SERVER_PORT must be a valid TCP port');
}

const adapterState = await loadNexusAdapters({
  directory: process.env.NEXUS_ADAPTER_DIR || path.join(root,'nexus-bridge','adapters')
});

const personalWatcher = startPersonalWatcher();

let pageWorkerChild = null;
let pageWorkerRestarts = 0;
let pageWorkerStartedAt = null;
let pageWorkerLastExit = null;
let pageWorkerRestartTimer = null;
let shuttingDown = false;

function pageWorkerSnapshot() {
  return {
    enabled: pageWorkerEnabled,
    running: Boolean(pageWorkerChild && pageWorkerChild.exitCode == null),
    pid: pageWorkerChild?.pid || null,
    startedAt: pageWorkerStartedAt,
    restarts: pageWorkerRestarts,
    lastExit: pageWorkerLastExit,
    healthFile: pageWorkerHealthFile
  };
}

function startPageWorker() {
  if (
    shuttingDown ||
    !pageWorkerEnabled ||
    Boolean(pageWorkerChild && pageWorkerChild.exitCode == null)
  ) {
    return;
  }

  const entry = path.join(root, 'nexmeta', 'src', 'page-worker.mjs');
  const startedAt = Date.now();

  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      NEXUS_ROOT: root,
      NEXMETA_BROWSER_DEBUG_PORT: String(browserDebugPort),
      NEXMETA_BROWSER_DEBUG_URL: `http://127.0.0.1:${browserDebugPort}`,
      NEXMETA_PAGE_STATE_FILE: pageWorkerStateFile,
      NEXMETA_PAGE_HEALTH_FILE: pageWorkerHealthFile,
      NEXUS_COMMAND_GATEWAY_URL:
        process.env.NEXUS_COMMAND_GATEWAY_URL ||
        `http://127.0.0.1:${port}/internal/nexus/events`,
      NEXUS_COMMAND_GATEWAY_KEY: sharedKey
    },
    stdio: 'inherit'
  });

  pageWorkerChild = child;
  pageWorkerStartedAt = new Date().toISOString();

  console.log('[NexMetaRuntime] Page worker started', {
    pid: child.pid,
    browserDebugPort
  });

  child.once('exit', (code, signal) => {
    if (pageWorkerChild === child) pageWorkerChild = null;

    pageWorkerLastExit = {
      at: new Date().toISOString(),
      code,
      signal: signal || null
    };

    if (shuttingDown) return;

    if (Date.now() - startedAt > 60_000) {
      pageWorkerRestarts = 0;
    }

    pageWorkerRestarts += 1;

    const delay = Math.min(
      60_000,
      3000 * (2 ** Math.min(pageWorkerRestarts - 1, 4))
    );

    console.error('[NexMetaRuntime] Page worker exited', {
      code,
      signal,
      restartInMs: delay
    });

    if (pageWorkerRestartTimer) clearTimeout(pageWorkerRestartTimer);
    pageWorkerRestartTimer = setTimeout(() => {
      pageWorkerRestartTimer = null;
      startPageWorker();
    }, delay);
    pageWorkerRestartTimer.unref?.();
  });
}

async function pageWorkerHealth() {
  if (!pageWorkerEnabled) {
    return {
      ok: true,
      enabled: false,
      process: pageWorkerSnapshot()
    };
  }

  try {
    const value = JSON.parse(await readFile(pageWorkerHealthFile, 'utf8'));
    const observedAt = Date.parse(String(value?.observedAt || ''));
    const fresh =
      Number.isFinite(observedAt) &&
      Date.now() - observedAt <= 90_000;

    return {
      ok:
        Boolean(pageWorkerChild && pageWorkerChild.exitCode == null) &&
        fresh &&
        value?.loggedIn === true &&
        value?.lastCycleOk === true,
      enabled: true,
      fresh,
      process: pageWorkerSnapshot(),
      health: value
    };
  } catch (error) {
    return {
      ok: false,
      enabled: true,
      fresh: false,
      process: pageWorkerSnapshot(),
      error: String(error?.message || error).slice(0, 240)
    };
  }
}

startPageWorker();

const seenEvents = new Map();
const dedupTtlMs = Math.max(60_000, Math.min(86_400_000, Number(process.env.NEXUS_BRIDGE_DEDUP_TTL_MS || 600_000)));

function pruneSeen(now=Date.now()) {
  for (const [key,expiresAt] of seenEvents) if (expiresAt <= now) seenEvents.delete(key);
}

async function claimEvent({ eventId, source }) {
  pruneSeen();
  const key = [source?.platform || 'unknown', source?.pageId || 'no-page', eventId].join(':');
  if (seenEvents.has(key)) return false;
  seenEvents.set(key, Date.now() + dedupTtlMs);
  return key;
}

async function releaseEvent(key) {
  if (key) seenEvents.delete(key);
}

function autoService(envelope) {
  const intent = String(envelope?.routing?.intent || '').toLowerCase();
  const byIntent = {
    download:'nexdownloader',
    game:'nexgame',
    sticker:'nexstick',
    whisper:'nexwhisper',
    group:'nexgroup',
    channel:'nexcanal',
    page_event:'nexcanal',
    assistant:'nexai'
  };
  const candidate = byIntent[intent];
  if (candidate && adapterState.services[candidate]) return candidate;
  return adapterState.services.auto ? 'auto' : (adapterState.services.nexai ? 'nexai' : 'auto');
}

const bridge = createNexusBridgeHandler({
  sharedKey,
  services: adapterState.services,
  serviceStatus: adapterState.status,
  resolveAuto: autoService,
  claimEvent,
  releaseEvent
});

function authorized(req) {
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i,'').trim();
  if (!sharedKey || !supplied) return false;
  const a=Buffer.from(supplied), b=Buffer.from(sharedKey);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}

function writeJson(res,status,value) {
  res.statusCode=status;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.end(JSON.stringify(value));
}

async function internalRequest(req,res) {
  const url=new URL(req.url || '/','http://nexmeta.internal');

  if (url.pathname.startsWith('/nexus-media/')) {
    return serveRemoteMedia(req,res,url.pathname.slice('/nexus-media/'.length).trim());
  }

  if (url.pathname==='/internal/nexus/events') {
    if (!sharedKey) return writeJson(res,503,{error:'bridge_key_missing'});
    return bridge(req,res);
  }

  if (url.pathname==='/internal/nexus/bridge-status') {
    if (!authorized(req)) return writeJson(res,401,{error:'unauthorized'});
    return writeJson(res,200,{
      ok:true,
      service:'nexmeta-pterodactyl-runtime',
      adapters:adapterState.status,
      mediaRegistry:mediaRegistryStats(),
      personalWatcher,
      pageWorker: await pageWorkerHealth()
    });
  }

  if (url.pathname==='/nexmeta/health') {
    req.url='/health'+url.search;
    return handleNexMeta(req,res);
  }

  return handleNexMeta(req,res);
}

async function publicRequest(req,res) {
  const url=new URL(req.url || '/','http://nexmeta.public');
  const path=url.pathname;

  if (path.startsWith('/nexus-media/')) {
    return serveRemoteMedia(req,res,path.slice('/nexus-media/'.length).trim());
  }

  if (path==='/health' || path==='/health/meta' || path==='/nexmeta/health') {
    req.url='/health'+url.search;
    return handleNexMeta(req,res);
  }

  if (
    path.startsWith('/companion/v1/') ||
    path.startsWith('/nexmeta/session/') ||
    path==='/setup/meta-app' ||
    path==='/connect/meta' ||
    path==='/oauth/meta/callback' ||
    path==='/webhooks/meta'
  ) {
    return handleNexMeta(req,res);
  }

  return writeJson(res,404,{error:'not_found'});
}

const server=http.createServer(internalRequest);
server.keepAliveTimeout=65000;
server.headersTimeout=70000;
server.listen(port,'127.0.0.1',()=>{
  console.log('[NexMetaRuntime] listening', {port, adapters:Object.keys(adapterState.services)});
});

let publicServer=null;
if (publicPort && publicPort!==port) {
  publicServer=http.createServer(publicRequest);
  publicServer.keepAliveTimeout=65000;
  publicServer.headersTimeout=70000;
  publicServer.listen(publicPort,'0.0.0.0',()=>{
    console.log('[NexMetaRuntime] public gateway listening', {publicPort});
  });
  publicServer.on('error',error=>{
    console.error('[NexMetaRuntime] public gateway error',String(error?.message||error));
  });
}

function shutdown(signal) {
  shuttingDown = true;
  console.log('[NexMetaRuntime] shutting down',signal);

  if (pageWorkerRestartTimer) {
    clearTimeout(pageWorkerRestartTimer);
    pageWorkerRestartTimer = null;
  }

  if (pageWorkerChild && pageWorkerChild.exitCode == null) {
    pageWorkerChild.kill(signal);
  }
  let pending=1+(publicServer?1:0);
  const done=()=>{
    pending-=1;
    if(pending<=0)process.exit(0);
  };
  server.close(done);
  if(publicServer)publicServer.close(done);
  setTimeout(()=>process.exit(0),5000).unref();
}
process.once('SIGTERM',()=>shutdown('SIGTERM'));
process.once('SIGINT',()=>shutdown('SIGINT'));
