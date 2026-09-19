import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable } from 'node:stream';

const registry = new Map();

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 4;

function now() {
  return Date.now();
}

function mediaTokenKey() {
  const secret = String(
    process.env.NEXUS_COMMAND_GATEWAY_KEY || ''
  ).trim();

  if (!secret) return null;

  return crypto
    .createHash('sha256')
    .update('nexus-media-v1:')
    .update(secret)
    .digest();
}

export function sealMediaItem(item) {
  const key = mediaTokenKey();
  if (!key) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    key,
    iv
  );

  const plaintext = Buffer.from(
    JSON.stringify(item),
    'utf8'
  );

  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);

  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url')
  ].join('.');
}

export function openMediaToken(token) {
  const value = String(token || '');
  const parts = value.split('.');

  if (parts.length !== 4 || parts[0] !== 'v1') {
    return null;
  }

  const key = mediaTokenKey();
  if (!key) return null;

  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const ciphertext = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');

    if (iv.length !== 12 || tag.length !== 16) {
      return null;
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      iv
    );

    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString('utf8');

    const item = JSON.parse(plaintext);

    if (
      !item ||
      typeof item !== 'object' ||
      !item.url ||
      !Number.isFinite(Number(item.expiresAt)) ||
      Number(item.expiresAt) <= now()
    ) {
      return null;
    }

    return item;
  } catch {
    return null;
  }
}


function prune() {
  const current = now();

  for (const [token, item] of registry) {
    if (item.expiresAt <= current) {
      registry.delete(token);
    }
  }
}

function isPrivateIpv4(value) {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) {
    return false;
  }

  const [a, b] = parts;

  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIpv6(value) {
  const normalized = value.toLowerCase();

  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.') ||
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized)
  );
}

function privateAddress(address) {
  const family = net.isIP(address);

  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);

  return true;
}

export async function assertPublicHttpUrl(raw) {
  const url = new URL(String(raw || ''));

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('unsupported_media_protocol');
  }

  const hostname = url.hostname.toLowerCase();

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('private_media_host');
  }

  if (net.isIP(hostname)) {
    if (privateAddress(hostname)) {
      throw new Error('private_media_address');
    }

    return url;
  }

  const resolved = await dns.lookup(hostname, {
    all: true,
    verbatim: true
  });

  if (!resolved.length) {
    throw new Error('media_host_not_resolved');
  }

  if (resolved.some(item => privateAddress(item.address))) {
    throw new Error('private_media_resolution');
  }

  return url;
}

function safeUpstreamHeaders(input = {}) {
  const output = {};

  for (const [key, value] of Object.entries(input || {})) {
    const normalized = String(key).toLowerCase();

    if (!['user-agent', 'referer', 'accept'].includes(normalized)) {
      continue;
    }

    output[normalized] = String(value).slice(0, 2000);
  }

  return output;
}

function publicBaseUrl() {
  const raw = String(
    process.env.NEXUS_PUBLIC_BASE_URL ||
    (
      process.env.RENDER_EXTERNAL_HOSTNAME
        ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
        : ''
    )
  ).trim();

  if (!raw) {
    throw new Error('NEXUS_PUBLIC_BASE_URL missing');
  }

  return raw.replace(/\/+$/, '');
}

export async function registerRemoteMedia({
  url,
  headers = {},
  ttlMs = DEFAULT_TTL_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  mediaType = null,
  filename = null
}) {
  const target = await assertPublicHttpUrl(url);

  const ttl = Math.max(
    60_000,
    Math.min(
      60 * 60 * 1000,
      Number(ttlMs) || DEFAULT_TTL_MS
    )
  );

  const byteLimit = Math.max(
    1024 * 1024,
    Math.min(
      1024 * 1024 * 1024,
      Number(maxBytes) || DEFAULT_MAX_BYTES
    )
  );

  prune();

  const item = {
    url: target.toString(),
    headers: safeUpstreamHeaders(headers),
    mediaType: mediaType ? String(mediaType) : null,
    filename: filename ? String(filename).slice(0, 180) : null,
    maxBytes: byteLimit,
    expiresAt: now() + ttl
  };

  let token = sealMediaItem(item);

  if (!token) {
    token = crypto.randomBytes(32).toString('base64url');
    registry.set(token, item);
  }

  return {
    token,
    url: `${publicBaseUrl()}/nexus-media/${token}`,
    expiresAt: new Date(item.expiresAt)
  };
}

export function inspectMediaToken(token) {
  prune();

  const item =
    openMediaToken(token) ||
    registry.get(String(token || ''));

  if (!item) return null;

  return {
    mediaType: item.mediaType,
    filename: item.filename,
    expiresAt: new Date(item.expiresAt),
    maxBytes: item.maxBytes
  };
}

async function fetchValidated(
  rawUrl,
  {
    method,
    headers,
    signal,
    redirects = 0
  }
) {
  if (redirects > MAX_REDIRECTS) {
    throw new Error('too_many_media_redirects');
  }

  const url = await assertPublicHttpUrl(rawUrl);

  const response = await fetch(url, {
    method,
    headers,
    redirect: 'manual',
    signal
  });

  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.headers.get('location')
  ) {
    const next = new URL(
      response.headers.get('location'),
      url
    );

    return fetchValidated(next, {
      method,
      headers,
      signal,
      redirects: redirects + 1
    });
  }

  return response;
}

function responseHeaders(upstream, item) {
  const headers = {
    'cache-control': 'private, max-age=60',
    'x-content-type-options': 'nosniff'
  };

  const contentType = upstream.headers.get('content-type');

  if (contentType) {
    headers['content-type'] = contentType;
  } else if (item.mediaType) {
    const fallback = {
      image: 'image/jpeg',
      video: 'video/mp4',
      audio: 'audio/mpeg',
      file: 'application/octet-stream'
    }[item.mediaType];

    if (fallback) headers['content-type'] = fallback;
  }

  for (const name of [
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified'
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }

  if (item.filename) {
    const safe = item.filename.replace(/[\r\n"]/g, '_');
    headers['content-disposition'] = `inline; filename="${safe}"`;
  }

  return headers;
}

function allowedMediaType(value) {
  const type = String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (!type) return true;

  return (
    type.startsWith('image/') ||
    type.startsWith('video/') ||
    type.startsWith('audio/') ||
    type === 'application/octet-stream' ||
    type === 'application/pdf' ||
    type === 'application/zip'
  );
}

export async function serveRemoteMedia(req, res, token) {
  prune();

  const item =
    openMediaToken(token) ||
    registry.get(String(token || ''));

  if (!item) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  if (!['GET', 'HEAD'].includes(req.method)) {
    res.statusCode = 405;
    res.setHeader('allow', 'GET, HEAD');
    res.end('Method not allowed');
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('media_timeout')),
    60_000
  );

  timer.unref?.();

  try {
    const headers = {
      ...item.headers
    };

    if (req.headers.range) {
      headers.range = String(req.headers.range);
    }

    const upstream = await fetchValidated(
      item.url,
      {
        method: req.method,
        headers,
        signal: controller.signal
      }
    );

    if (!upstream.ok && upstream.status !== 206) {
      res.statusCode = 502;
      res.end('Upstream media unavailable');
      return;
    }

    const contentLength = Number(
      upstream.headers.get('content-length') || 0
    );

    if (
      Number.isFinite(contentLength) &&
      contentLength > item.maxBytes
    ) {
      res.statusCode = 413;
      res.end('Media too large');
      return;
    }

    if (!allowedMediaType(upstream.headers.get('content-type'))) {
      res.statusCode = 415;
      res.end('Unsupported upstream media type');
      return;
    }

    res.statusCode = upstream.status;

    for (const [name, value] of Object.entries(
      responseHeaders(upstream, item)
    )) {
      res.setHeader(name, value);
    }

    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return;
    }

    let streamed = 0;
    const body = Readable.fromWeb(upstream.body);

    body.on('data', chunk => {
      streamed += chunk.length;

      if (streamed > item.maxBytes) {
        controller.abort();
        body.destroy(new Error('media_too_large'));
      }
    });

    await new Promise((resolve, reject) => {
      let settled = false;

      const finish = error => {
        if (settled) return;
        settled = true;

        if (error) reject(error);
        else resolve();
      };

      body.once('end', () => finish());
      body.once('error', error => finish(error));
      res.once('close', () => finish());

      body.pipe(res);
    }).catch(error => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end('Media relay failed');
      } else if (!res.destroyed) {
        res.destroy(error);
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

export function mediaRegistryStats() {
  prune();

  return {
    activeFallbackTokens: registry.size,
    statelessTokens:
      Boolean(mediaTokenKey())
  };
}
