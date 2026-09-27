import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const sleep = ms => new Promise(r => setTimeout(r, ms));
if (!process.env.NEXUS_PUBLIC_BASE_URL && process.env.RENDER_EXTERNAL_HOSTNAME) {
  process.env.NEXUS_PUBLIC_BASE_URL = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
}
const now = () => Date.now();

const stopping = { value: false };
const children = new Map();
const restartHistory = new Map();
const restartTimers = new Map();
const startedAt = now();

const liteStateFile = process.env.NEX_LITEAPKS_STATE_FILE
  || process.env.NEXCANAL__WATCHER_STATE_FILE
  || '/var/data/nexcanal-watch-state-v2.json';
const liteHeartbeatMs = Math.max(120_000, Number(process.env.NEX_RENDER_LITEAPK_STALE_MS || 6 * 60_000));
const startupGraceMs = Math.max(liteHeartbeatMs, Number(process.env.NEX_RENDER_WORKER_STARTUP_GRACE_MS || 8 * 60_000));
const maxRestarts = Math.max(3, Number(process.env.NEX_RENDER_MAX_RESTARTS || 10));
const restartWindowMs = Math.max(60_000, Number(process.env.NEX_RENDER_RESTART_WINDOW_MS || 10 * 60_000));

function log(...args) { console.log('[render-supervisor]', ...args); }
function warn(...args) { console.warn('[render-supervisor]', ...args); }

function commandSpec(name) {
  if (name === 'orchestrator') return { file: process.execPath, args: ['scripts/orchestrator.mjs'], core: true };
  if (name === 'liteapks') return { file: process.execPath, args: ['watchers/liteapks-relay.mjs'], core: false };
  if (name === 'anime') return { file: process.execPath, args: ['watchers/anime-pipeline.mjs'], core: false };
  throw new Error(`unknown process ${name}`);
}

function pruneRestarts(name) {
  const cutoff = now() - restartWindowMs;
  const rows = (restartHistory.get(name) || []).filter(ts => ts >= cutoff);
  restartHistory.set(name, rows);
  return rows;
}

function recordRestart(name) {
  const rows = pruneRestarts(name);
  rows.push(now());
  restartHistory.set(name, rows);
  return rows.length;
}

function requestFullRestart(reason) {
  if (stopping.value) return;
  warn('requesting full container restart:', reason);
  stopping.value = true;
  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();
  for (const child of children.values()) {
    try { child.kill('SIGTERM'); } catch {}
  }
  const killer = setTimeout(() => {
    for (const child of children.values()) {
      try { child.kill('SIGKILL'); } catch {}
    }
    process.exit(1);
  }, 10_000);
  killer.unref?.();
  setTimeout(() => process.exit(1), 1500).unref?.();
}

function scheduleRestart(name, cause = 'exit') {
  if (stopping.value || restartTimers.has(name)) return;
  const count = recordRestart(name);
  if (count > maxRestarts) {
    requestFullRestart(`${name} exceeded ${maxRestarts} restarts in ${Math.round(restartWindowMs / 60000)}m (${cause})`);
    return;
  }
  const delay = Math.min(60_000, 2_000 * (2 ** Math.min(count - 1, 5)));
  warn(`${name} stopped (${cause}); restart #${count} in ${delay}ms`);
  const timer = setTimeout(() => {
    restartTimers.delete(name);
    start(name);
  }, delay);
  restartTimers.set(name, timer);
}

function start(name) {
  if (stopping.value) return null;
  const spec = commandSpec(name);
  const existing = children.get(name);
  if (existing && existing.exitCode === null && !existing.killed) return existing;

  const child = spawn(spec.file, spec.args, {
    cwd: '/app',
    env: process.env,
    stdio: 'inherit'
  });
  children.set(name, child);
  log('started', name, `pid=${child.pid}`);

  let handled = false;
  const onStopped = (why) => {
    if (handled) return;
    handled = true;
    if (children.get(name) === child) children.delete(name);
    if (stopping.value) return;
    if (spec.core) {
      requestFullRestart(`${name} stopped unexpectedly (${why})`);
      return;
    }
    scheduleRestart(name, why);
  };

  child.once('error', error => onStopped(`spawn error: ${error?.message || error}`));
  child.once('exit', (code, signal) => onStopped(`code=${code ?? 'null'} signal=${signal ?? 'none'}`));
  return child;
}

async function runPreflight() {
  log('running preflight');
  const child = spawn(process.execPath, ['scripts/preflight.mjs'], {
    cwd: '/app', env: process.env, stdio: 'inherit'
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', c => resolve(c ?? 1));
  });
  if (code !== 0) throw new Error(`preflight failed with exit code ${code}`);
  log('preflight ok');
}

async function readLiteHeartbeat() {
  try {
    const doc = JSON.parse(await fs.readFile(liteStateFile, 'utf8'));
    const updated = Date.parse(String(doc?.updatedAt || ''));
    const cycle = Number(doc?.health?.lastCycleAt || 0);
    return Math.max(Number.isFinite(updated) ? updated : 0, Number.isFinite(cycle) ? cycle : 0);
  } catch {
    return 0;
  }
}

async function restartWorker(name, reason) {
  const child = children.get(name);
  if (!child || child.exitCode !== null || child.killed) {
    scheduleRestart(name, reason);
    return;
  }
  warn('restarting', name, reason);
  try { child.kill('SIGTERM'); } catch {}
  await sleep(5_000);
  if (child.exitCode === null && !child.killed) {
    try { child.kill('SIGKILL'); } catch {}
  }
}

async function heartbeatLoop() {
  while (!stopping.value) {
    await sleep(60_000);
    if (stopping.value) break;
    if (!children.has('liteapks')) continue;
    if (now() - startedAt < startupGraceMs) continue;
    const heartbeat = await readLiteHeartbeat();
    const age = heartbeat ? now() - heartbeat : Infinity;
    if (!heartbeat || age > liteHeartbeatMs) {
      await restartWorker('liteapks', `stale heartbeat age=${Number.isFinite(age) ? age : 'missing'}ms`);
    }
  }
}

async function shutdown(signal) {
  if (stopping.value) return;
  stopping.value = true;
  log('received', signal, 'stopping children');
  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();
  for (const child of children.values()) {
    try { child.kill('SIGTERM'); } catch {}
  }
  await sleep(3_000);
  for (const child of children.values()) {
    if (child.exitCode === null && !child.killed) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', error => requestFullRestart(`uncaughtException: ${error?.stack || error}`));
process.on('unhandledRejection', error => requestFullRestart(`unhandledRejection: ${error?.stack || error}`));

await runPreflight();
start('orchestrator');
if (String(process.env.NEXCANAL__WATCHER_SESSION || '').trim()) start('liteapks');
if (String(process.env.NEXANIME__ENABLED ?? 'true').trim().toLowerCase() !== 'false') start('anime');
void heartbeatLoop();

setInterval(() => {
  const status = [...children.entries()].map(([name, child]) => `${name}:${child.pid ?? 'no-pid'}`).join(', ');
  log('alive', status || 'no children');
}, 5 * 60_000).unref?.();
