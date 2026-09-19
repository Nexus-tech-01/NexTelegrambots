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
import { completeMetaOAuth } from './meta-oauth.mjs';
import { connectedPageState } from './token-vault.mjs';
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

function writeHtml(res, status, title, message) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · NexMeta</title>
<style>
html{background:#080808;color:#f4f4f4;font-family:system-ui,-apple-system,sans-serif}
body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px}
main{max-width:620px;border:1px solid #2a2a2a;border-radius:24px;padding:34px;background:#111}
small{letter-spacing:.15em;text-transform:uppercase;color:#999}
h1{font-size:38px;margin:12px 0}
p{color:#bbb;line-height:1.6;margin:0}
</style>
</head>
<body><main><small>NexMeta · Meta connection</small><h1>${title}</h1><p>${message}</p></main></body>
</html>`);
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
    oauth_callback: '/oauth/meta/callback',
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

async function metaOAuthCallback(res, url) {
  if (url.searchParams.get('error')) {
    await audit('nexmeta.oauth.denied', 'facebook', {
      error: String(url.searchParams.get('error')).slice(0, 120)
    }).catch(() => {});

    return writeHtml(
      res,
      400,
      'Connexion annulée',
      'Facebook n’a pas accordé l’autorisation demandée. Tu peux fermer cette page et relancer la connexion depuis NexControl.'
    );
  }

  const code = String(url.searchParams.get('code') || '');
  const state = String(url.searchParams.get('state') || '');

  if (!code || !state) {
    return writeHtml(
      res,
      400,
      'Connexion invalide',
      'Le callback Meta ne contient pas les paramètres de sécurité nécessaires.'
    );
  }

  try {
    const result = await completeMetaOAuth({ code, state });

    await audit('nexmeta.oauth.connected', result.actor || 'nexcontrol', {
      pagesDiscovered: result.pagesDiscovered,
      pagesStored: result.pagesStored,
      pageIds: result.pages.map(page => page.pageId),
      webhookProvisioned: result.webhooks?.success === true,
      pageWebhookResults: (result.webhooks?.pages || []).map(item => ({
        pageId: item.pageId,
        success: item.success === true,
        metaCode: item.metaCode ?? null
      }))
    });

    const webhookMessage = result.webhooks?.success
      ? ' Les webhooks Meta ont aussi été configurés automatiquement.'
      : ' Les Pages sont enregistrées, mais au moins un abonnement webhook reste à corriger depuis NexControl.';

    return writeHtml(
      res,
      200,
      'Facebook connecté',
      `${result.pagesStored} Page(s) ont été ajoutée(s) à NexMeta. Les tokens sont chiffrés côté serveur et ne sont pas affichés ici.${webhookMessage} Tu peux revenir dans NexControl.`
    );
  } catch (error) {
    await audit('nexmeta.oauth.failed', 'facebook', {
      error: String(error?.message || 'oauth_failed').slice(0, 500),
      metaCode: error?.metaCode ?? null
    }).catch(() => {});

    return writeHtml(
      res,
      Number(error?.status) >= 400 && Number(error?.status) < 500 ? 400 : 502,
      'Connexion échouée',
      'NexMeta n’a pas pu finaliser la connexion Facebook. Relance la connexion depuis NexControl ; aucun token n’est affiché dans cette page.'
    );
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

async function control(req, res, url, path) {
  if (!authorizeControl(req.headers.authorization, config.controlKey)) {
    return writeJson(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && path === '/internal/v1/status') {
    const [runtime, pages] = await Promise.all([
      getRuntimeSettings(),
      connectedPageState()
    ]);

    await audit('nexmeta.status.read', 'nexcontrol');

    return writeJson(res, 200, {
      ok: true,
      service: 'nexmeta',
      version: '0.4.0',
      metaConfigured: metaConfigured(),
      runtime,
      pages,
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

      const [runtime, pages] = await Promise.all([
        getRuntimeSettings(),
        connectedPageState()
      ]);

      return writeJson(res, 200, {
        ok: true,
        service: 'nexmeta',
        version: '0.4.0',
        metaConfigured: metaConfigured(),
        runtime,
        pages
      });
    }

    if (req.method === 'GET' && path === '/oauth/meta/callback') {
      return metaOAuthCallback(res, url);
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
