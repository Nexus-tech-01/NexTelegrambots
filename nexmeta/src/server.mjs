import http from 'node:http';
import { config, assertRuntimeConfig, metaConfigured } from './config.mjs';
import {
  verifyWebhookChallenge,
  verifyMetaSignature,
  authorizeControl,
  sha256
} from './security.mjs';
import {
  normalizeMessengerWebhook,
  eventIdentity
} from './normalizer.mjs';
import {
  persistWebhook,
  markWebhookProcessed,
  upsertIdentity,
  saveMessage,
  audit,
  healthStore,
  getRuntimeSettings
} from './store.mjs';
import { routeInbound } from './router.mjs';
import { sendText, senderAction } from './meta-client.mjs';
import {
  CONTROL_CAPABILITIES,
  controlAuditMetadata,
  executeControlAction
} from './control-actions.mjs';

assertRuntimeConfig();

function writeJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

async function readRaw(req, maxBytes = 2 * 1024 * 1024) {
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

async function processInboundEvent(event) {
  if (!event.senderId) return;

  await upsertIdentity(eventIdentity(event));

  if (event.type === 'message') {
    await saveMessage({
      platform: 'facebook',
      surface: 'messenger',
      pageId: event.pageId,
      externalUserId: event.senderId,
      externalMessageId: event.externalMessageId,
      direction: 'inbound',
      text: event.text,
      attachments: event.attachments,
      timestamp: new Date(event.timestamp)
    });
  }

  if (!['message', 'postback'].includes(event.type) || event.isEcho) return;

  const settings = await getRuntimeSettings();
  if (!settings.inboundEnabled) {
    await audit('nexmeta.inbound.skipped', 'runtime', {
      reason: 'inbound_disabled',
      pageId: event.pageId,
      senderId: event.senderId,
      eventType: event.type
    });
    return;
  }

  if (!settings.outboundEnabled) {
    await audit('nexmeta.response.skipped', 'runtime', {
      reason: 'outbound_disabled',
      pageId: event.pageId,
      senderId: event.senderId,
      eventType: event.type
    });
    return;
  }

  await Promise.allSettled([
    senderAction(event.senderId, 'mark_seen'),
    senderAction(event.senderId, 'typing_on')
  ]);

  try {
    const result = await routeInbound(event);

    if (result?.text) {
      const sent = await sendText(event.senderId, result.text);
      await saveMessage({
        platform: 'facebook',
        surface: 'messenger',
        pageId: event.pageId,
        externalUserId: event.senderId,
        externalMessageId: sent?.message_id || null,
        direction: 'outbound',
        text: result.text,
        timestamp: new Date()
      });
    }
  } finally {
    await senderAction(event.senderId, 'typing_off').catch(() => {});
  }
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

  writeJson(res, 200, { ok: true });

  try {
    const events = normalizeMessengerWebhook(payload);
    for (const event of events) await processInboundEvent(event);
    await markWebhookProcessed(eventKey);
  } catch (error) {
    console.error('[NexMeta webhook]', error);
    await markWebhookProcessed(eventKey, 'failed', error?.stack || error);
  }
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

async function control(req, res, url) {
  if (!authorizeControl(req.headers.authorization, config.controlKey)) {
    return writeJson(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && url.pathname === '/internal/v1/status') {
    const runtime = await getRuntimeSettings();
    await audit('nexmeta.status.read', 'nexcontrol');

    return writeJson(res, 200, {
      ok: true,
      service: 'nexmeta',
      version: '0.2.0-dev',
      metaConfigured: metaConfigured(),
      runtime,
      capabilities: CONTROL_CAPABILITIES,
      secretExposure: false
    });
  }

  if (req.method === 'POST' && url.pathname === '/internal/v1/actions') {
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://nexmeta.local');

    if (req.method === 'GET' && url.pathname === '/health') {
      await healthStore();
      const runtime = await getRuntimeSettings();

      return writeJson(res, 200, {
        ok: true,
        service: 'nexmeta',
        version: '0.2.0-dev',
        metaConfigured: metaConfigured(),
        runtime
      });
    }

    if (req.method === 'GET' && url.pathname === '/webhooks/meta') {
      const result = verifyWebhookChallenge(url.searchParams, config.verifyToken);
      if (!result.ok) {
        return writeJson(res, 403, { error: 'verification_failed' });
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end(result.challenge);
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/meta') {
      return await metaWebhookPost(req, res);
    }

    if (url.pathname.startsWith('/internal/v1/')) {
      return await control(req, res, url);
    }

    return writeJson(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error('[NexMeta]', error);
    if (!res.headersSent) {
      return writeJson(res, error?.status || 500, { error: 'internal_error' });
    }
    res.end();
  }
});

server.listen(config.port, () => {
  console.log(`[NexMeta] listening on :${config.port}`);
});
