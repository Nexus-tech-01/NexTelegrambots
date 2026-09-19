import { config, metaConfigured } from './config.mjs';
import {
  verifyWebhookChallenge,
  verifyMetaSignature,
  authorizeControl,
  sha256
} from './security.mjs';
import {
  persistWebhook,
  audit,
  healthStore,
  getRuntimeSettings
} from './store.mjs';
import { processWebhookPayload } from './processor.mjs';
import {
  CONTROL_CAPABILITIES,
  controlAuditMetadata,
  executeControlAction
} from './control-actions.mjs';

function writeJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

async function readRaw(req, maxBytes = 2 * 1024 * 1024) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('payload_too_large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function routePath(url) {
  const forced = url.searchParams.get('__route');
  if (!forced) return url.pathname;

  const map = {
    health: '/health',
    webhook: '/webhooks/meta',
    status: '/internal/v1/status',
    actions: '/internal/v1/actions'
  };

  return map[forced] || url.pathname;
}

async function metaWebhookPost(req, res) {
  const raw = await readRaw(req);

  if (!verifyMetaSignature(raw, req.headers['x-hub-signature-256'], config.appSecret)) {
    return writeJson(res, 401, { error: 'invalid_signature' });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return writeJson(res, 400, { error: 'invalid_json' });
  }

  const eventKey = sha256(raw);
  const persisted = await persistWebhook({
    eventKey,
    raw: payload,
    objectType: payload.object || 'unknown'
  });

  if (persisted.duplicate) {
    return writeJson(res, 200, { ok: true, duplicate: true });
  }

  const background = processWebhookPayload(eventKey, payload);
  writeJson(res, 200, { ok: true });

  if (typeof req.nexmetaWaitUntil === 'function') {
    req.nexmetaWaitUntil(background);
    return;
  }

  await background;
}

function publicActionError(error) {
  return {
    error: error?.message === 'unsupported_action'
      ? 'unsupported_action'
      : 'action_failed',
    message: String(error?.message || 'Action failed').slice(0, 500),
    metaCode: error?.metaCode ?? null,
    metaSubcode: error?.metaSubcode ?? null
  };
}

async function control(req, res, url, path) {
  if (!authorizeControl(req.headers.authorization, config.controlKey)) {
    return writeJson(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && path === '/internal/v1/status') {
    const runtime = await getRuntimeSettings();
    await audit('nexmeta.status.read', 'nexcontrol');

    return writeJson(res, 200, {
      ok: true,
      service: 'nexmeta',
      version: '0.2.0',
      metaConfigured: metaConfigured(),
      runtime,
      capabilities: CONTROL_CAPABILITIES,
      secretExposure: false
    });
  }

  if (req.method === 'POST' && path === '/internal/v1/actions') {
    const raw = await readRaw(req, 512 * 1024);
    let body;

    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return writeJson(res, 400, { error: 'invalid_json' });
    }

    const action = String(body?.action || 'unknown');

    try {
      const result = await executeControlAction(body);

      await audit(`nexmeta.${action}`, 'nexcontrol', {
        ...controlAuditMetadata(body),
        ok: true
      });

      return writeJson(res, 200, { ok: true, result });
    } catch (error) {
      await audit(`nexmeta.${action}`, 'nexcontrol', {
        ...controlAuditMetadata(body),
        ok: false,
        error: String(error?.message || 'error').slice(0, 500),
        metaCode: error?.metaCode ?? null
      }).catch(() => {});

      const status = Number(error?.status);
      const httpStatus =
        status >= 400 && status <= 599
          ? status
          : error?.message === 'unsupported_action'
            ? 400
            : 502;

      return writeJson(res, httpStatus, publicActionError(error));
    }
  }

  return writeJson(res, 404, { error: 'not_found' });
}

export async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://nexmeta.local');
    const path = routePath(url);

    if (req.method === 'GET' && path === '/health') {
      await healthStore();
      const runtime = await getRuntimeSettings();

      return writeJson(res, 200, {
        ok: true,
        service: 'nexmeta',
        version: '0.2.0',
        metaConfigured: metaConfigured(),
        runtime
      });
    }

    if (req.method === 'GET' && path === '/webhooks/meta') {
      const result = verifyWebhookChallenge(url.searchParams, config.verifyToken);

      if (!result.ok) {
        return writeJson(res, 403, { error: 'verification_failed' });
      }

      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end(result.challenge);
    }

    if (req.method === 'POST' && path === '/webhooks/meta') {
      return await metaWebhookPost(req, res);
    }

    if (path.startsWith('/internal/v1/')) {
      return await control(req, res, url, path);
    }

    return writeJson(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error('[NexMeta]', error);

    if (!res.headersSent) {
      return writeJson(res, error?.status || 500, {
        error: 'internal_error'
      });
    }

    res.end();
  }
}
