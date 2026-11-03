'use strict';

// Direct SSH recovery: this endpoint never uses NexControl's VPS agent or Supabase.
// Disabled unless NXC_SSH_ADMIN_TOKEN and NXC_SSH_ALLOWED_HOSTS are configured.
const { createHash, timingSafeEqual } = require('node:crypto');
const { isIP } = require('node:net');

function reply(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(JSON.stringify(data));
}

function secureEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

function validateTarget(host, port) {
  // Only literal IPv4 destinations explicitly approved by the project owner.
  // DNS names are rejected to prevent DNS rebinding and cloud metadata access.
  if (typeof host !== 'string' || isIP(host) !== 4) return false;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const allowed = String(process.env.NXC_SSH_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(host) && port === Number(process.env.NXC_SSH_PORT || 22);
}

function fingerprintOf(key) {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' && req.body.length < 8192) {
    try { return JSON.parse(req.body); } catch {}
  }
  return {};
}

function connectSSH({ host, port, username, password, mode, expectedFingerprint, command }) {
  return new Promise((resolve) => {
    const { Client } = require('ssh2');
    const conn = new Client();
    let settled = false, fingerprint = '', stdout = '', stderr = '', exitCode = null;
    const limit = 32000;
    const timer = setTimeout(() => finish(504, { error: 'ssh_timeout' }), 22000);
    function finish(status, data) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch {}
      try { conn.destroy(); } catch {}
      resolve({ status, data });
    }
    conn.on('error', (err) => {
      if (mode === 'fingerprint' && fingerprint) return finish(200, { ok: true, fingerprint });
      if (fingerprint && expectedFingerprint !== fingerprint)
        return finish(409, { error: 'host_key_changed', fingerprint });
      const message = String(err?.message || '');
      const error = /All configured authentication methods failed|authentication/i.test(message)
        ? 'ssh_authentication_failed'
        : /timeout/i.test(message) ? 'ssh_timeout' : 'ssh_connection_failed';
      finish(error === 'ssh_authentication_failed' ? 401 : 502, { error });
    });
    conn.on('close', () => {
      if (mode === 'fingerprint' && fingerprint) finish(200, { ok: true, fingerprint });
      else if (!settled) finish(502, { error: 'ssh_connection_closed' });
    });
    conn.on('ready', () => {
      if (mode === 'fingerprint') return finish(200, { ok: true, fingerprint });
      conn.exec(command, { pty: false }, (err, stream) => {
        if (err) return finish(502, { error: 'ssh_exec_failed' });
        stream.on('data', b => { stdout = (stdout + String(b)).slice(0, limit); });
        stream.stderr.on('data', b => { stderr = (stderr + String(b)).slice(0, limit); });
        stream.on('exit', code => { exitCode = Number.isInteger(code) ? code : null; });
        stream.on('close', () => finish(200, { ok: true, stdout, stderr, exitCode, fingerprint }));
        stream.on('error', () => finish(502, { error: 'ssh_stream_failed' }));
      });
    });
    try {
      conn.connect({
        host, port, username: username || 'root',
        ...(mode === 'exec' ? { password, tryKeyboard: false } : {}),
        readyTimeout: 10000,
        keepaliveInterval: 0,
        hostVerifier: key => {
          fingerprint = fingerprintOf(key);
          return mode === 'exec' && secureEqual(expectedFingerprint, fingerprint);
        }
      });
    } catch {
      finish(502, { error: 'ssh_connection_failed' });
    }
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'method_not_allowed' });
  const admin = process.env.NXC_SSH_ADMIN_TOKEN || '';
  if (admin.length < 32 || !process.env.NXC_SSH_ALLOWED_HOSTS)
    return reply(res, 503, { error: 'ssh_gateway_not_configured' });
  const accessToken = String(req.headers?.['x-nxc-ssh-token'] || '');
  if (!secureEqual(admin, accessToken)) return reply(res, 401, { error: 'unauthorized' });
  const origin = req.headers?.origin;
  const hostHeader = String(req.headers?.host || '');
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'https:' || parsed.host !== hostHeader)
        return reply(res, 403, { error: 'origin_mismatch' });
    } catch {
      return reply(res, 403, { error: 'origin_mismatch' });
    }
  }
  const b = readBody(req);
  const host = b.host, port = Number(b.port || 22), mode = b.mode;
  if (!validateTarget(host, port)) return reply(res, 403, { error: 'host_not_allowed' });
  if (!['fingerprint', 'exec'].includes(mode)) return reply(res, 400, { error: 'invalid_mode' });
  const username = String(b.username || 'root');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) return reply(res, 400, { error: 'invalid_username' });
  const command = b.command;
  if (mode === 'exec') {
    if (typeof b.password !== 'string' || !b.password || b.password.length > 256)
      return reply(res, 400, { error: 'password_required' });
    if (typeof command !== 'string' || !command.trim() || command.length > 2048)
      return reply(res, 400, { error: 'invalid_command' });
    if (typeof b.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(b.fingerprint))
      return reply(res, 400, { error: 'fingerprint_required' });
  }
  try {
    const result = await connectSSH({
      host, port, username, password: b.password, mode,
      expectedFingerprint: b.fingerprint, command
    });
    return reply(res, result.status, result.data);
  } catch {
    return reply(res, 502, { error: 'ssh_connection_failed' });
  }
}

module.exports = handler;
module.exports._test = { secureEqual, validateTarget, fingerprintOf };
