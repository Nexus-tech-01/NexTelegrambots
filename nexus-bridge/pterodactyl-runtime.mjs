import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { createNexusBridgeHandler } from './receiver.mjs';
import { loadNexusAdapters } from './adapter-loader.mjs';
import { serveRemoteMedia, mediaRegistryStats } from './media-registry.mjs';
import { handleRequest as handleNexMeta } from '../nexmeta/src/handler.mjs';

const root = path.resolve(process.env.NEXUS_ROOT || process.cwd());
const port = Number(process.env.NEXMETA_INTERNAL_PORT || 3110);
const publicPort = Number(process.env.NEXMETA_PUBLIC_PORT || process.env.SERVER_PORT || 0);
const sharedKey = String(process.env.NEXUS_COMMAND_GATEWAY_KEY || '').trim();

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
      mediaRegistry:mediaRegistryStats()
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
  console.log('[NexMetaRuntime] shutting down',signal);
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
