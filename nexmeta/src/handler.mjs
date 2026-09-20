import fs from 'node:fs';
import path from 'node:path';

import {
  config,
  metaConfigured,
  oauthConfigured,
  publicHttpsConfigured
} from './config.mjs';
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
  completeMetaOAuth,
  createMetaOAuthStart
} from './meta-oauth.mjs';
import {
  connectedPageState,
  connectedAccountState
} from './token-vault.mjs';
import {
  CONTROL_CAPABILITIES,
  controlAuditMetadata,
  executeControlAction
} from './control-actions.mjs';
import {
  pairCompanion,
  pollCompanionCommands,
  acknowledgeCompanionCommand,
  ingestCompanionEvents,
  companionDeviceStatus
} from './companion.mjs';

function writeJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

function writeHtml(res, status, title, message) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
  );
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
      accountConnected: result.accountConnected === true,
      accountUserId: result.account?.userId || null,
      pagesDiscovered: result.pagesDiscovered,
      pagesStored: result.pagesStored,
      messengerCapablePages: result.messengerCapablePages,
      pageIds: result.pages.map(page => page.pageId),
      webhookProvisioned: result.webhooks?.success === true,
      permissionDiscoveryError: result.permissionDiscoveryError || null,
      pageDiscoveryError: result.pageDiscoveryError || null,
      pageWebhookResults: (result.webhooks?.pages || []).map(item => ({
        pageId: item.pageId,
        success: item.success === true,
        metaCode: item.metaCode ?? null
      }))
    });

    const pagesMessage = result.pagesStored > 0
      ? ` ${result.pagesStored} Page(s) administrée(s) ont aussi été ajoutée(s) à NexMeta.`
      : ' Aucune Page administrable n’a été ajoutée ; le compte reste néanmoins connecté à NexMeta.';

    const messengerMessage = result.messengerCapablePages > 0
      ? ` ${result.messengerCapablePages} Page(s) disposent d’un rôle Messenger.`
      : result.pagesStored > 0
        ? ' Messenger restera limité aux Pages qui disposent de la tâche de messagerie requise.'
        : '';

    const webhookMessage = result.pagesStored === 0
      ? ''
      : result.webhooks?.success
        ? ' Les webhooks Meta ont aussi été configurés automatiquement.'
        : ' Au moins un abonnement webhook Page reste à corriger depuis NexControl.';

    const discoveryMessage = result.pageDiscoveryError
      ? ' La découverte des Pages a rencontré une erreur Meta ; tu peux relancer cette partie depuis NexControl sans perdre la connexion du compte.'
      : '';

    return writeHtml(
      res,
      200,
      'Compte Facebook connecté',
      `Le compte Facebook propriétaire est maintenant relié à NexMeta. Son token utilisateur est chiffré côté serveur et n’est jamais affiché dans le navigateur.${pagesMessage}${messengerMessage}${webhookMessage}${discoveryMessage} Tu peux revenir dans NexControl.`
    );
  } catch (error) {
    await audit('nexmeta.oauth.failed', 'facebook', {
      error: String(error?.message || 'oauth_failed').slice(0, 500),
      metaCode: error?.metaCode ?? null
    }).catch(() => {});

    return writeHtml(
      res,
      Number(error?.status) >= 400 && Number(error?.status) < 500
        ? Number(error.status)
        : 502,
      'Connexion échouée',
      'NexMeta n’a pas pu finaliser la connexion du compte Facebook. Relance la connexion depuis /connect/meta ou NexControl ; aucun token n’est affiché dans cette page.'
    );
  }
}


const META_APP_SETUP_FILE = path.resolve(
  process.env.NEXMETA_APP_SETUP_FILE ||
  '/home/container/.nexcontrol/meta-app-setup.json'
);

function readMetaAppSetupRecord() {
  try {
    const record = JSON.parse(
      fs.readFileSync(META_APP_SETUP_FILE, 'utf8')
    );

    const expiresAt = new Date(record?.expiresAt || '').getTime();
    if (
      !record?.hash ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    ) {
      return null;
    }

    return {
      hash: String(record.hash),
      expiresAt
    };
  } catch {
    return null;
  }
}

function validMetaAppSetupNonce(nonce) {
  const record = readMetaAppSetupRecord();
  if (!record || !nonce) return false;
  return sha256(String(nonce)) === record.hash;
}

function persistMetaAppCredentials(appId, appSecret) {
  const envPath = '/home/container/.env';
  const raw = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '')
    : '';

  const desired = new Map([
    ['NEXMETA_APP_ID', String(appId)],
    ['NEXMETA_APP_SECRET', String(appSecret)]
  ]);

  const output = [];
  const seen = new Set();

  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf('=');
    const key = index > 0 ? line.slice(0, index).trim() : '';

    if (desired.has(key)) {
      if (!seen.has(key)) {
        output.push(`${key}=${desired.get(key)}`);
        seen.add(key);
      }
      continue;
    }

    output.push(line);
  }

  for (const [key, value] of desired) {
    if (!seen.has(key)) output.push(`${key}=${value}`);
  }

  const tmp = `${envPath}.nexmeta-${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    output.join('\n').replace(/\n+$/, '') + '\n',
    { mode: 0o600 }
  );
  fs.renameSync(tmp, envPath);

  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    // Best-effort on filesystems without chmod support.
  }
}

function metaAppSetupSecurityHeaders(res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-robots-tag', 'noindex, nofollow');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://*.supabase.co; base-uri 'none'; frame-ancestors 'none'"
  );
}

function metaAppSetupPage({ nonce, error = '' } = {}) {
  const action = `${config.publicBaseUrl.replace(/\/+$/, '')}/setup/meta-app`
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');

  const safeNonce = String(nonce || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const safeError = String(error || '')
    .replace(/[&<>]/g, '');

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Configurer Meta · NexMeta</title>
<style>
html{background:#080808;color:#f4f4f4;font-family:system-ui,-apple-system,sans-serif}
body{min-height:100vh;margin:0;display:grid;place-items:center;padding:22px}
main{width:min(620px,100%);box-sizing:border-box;border:1px solid #2a2a2a;border-radius:24px;padding:30px;background:#111}
small{letter-spacing:.14em;text-transform:uppercase;color:#999}
h1{font-size:36px;margin:12px 0 10px;letter-spacing:-.04em}
p{color:#aaa;line-height:1.55}
ol{color:#bbb;line-height:1.6;padding-left:22px}
label{display:block;margin:20px 0 7px;font-size:12px;color:#aaa;text-transform:uppercase;letter-spacing:.08em}
input{width:100%;box-sizing:border-box;background:#090909;color:#fff;border:1px solid #333;border-radius:14px;padding:14px 16px;font:inherit}
button{margin-top:16px;width:100%;border:0;border-radius:14px;padding:14px 16px;background:#f2f2f2;color:#090909;font:700 15px system-ui;cursor:pointer}
.err{color:#ffb0b0}
.note{font-size:12px;color:#777;margin-top:18px}
code{color:#ddd}
</style>
</head>
<body><main>
<small>NexMeta · Secure Meta setup</small>
<h1>Relier ton App Meta</h1>
<p>Cette page est temporaire et à usage unique. L’App Secret part directement vers NexMeta via HTTPS et n’est pas affiché dans le chat.</p>
<ol>
<li>Dans Meta for Developers, crée/ouvre l’app qui servira à NexMeta.</li>
<li>Dans <b>Settings → Basic</b>, copie son <b>App ID</b> et son <b>App Secret</b>.</li>
<li>Colle-les ci-dessous. Après validation, NexMeta ouvrira immédiatement l’autorisation Facebook.</li>
</ol>
${safeError ? `<p class="err">${safeError}</p>` : ''}
<form method="post" action="${action}" autocomplete="off">
<input type="hidden" name="setup" value="${safeNonce}">
<label for="app_id">Meta App ID</label>
<input id="app_id" name="app_id" inputmode="numeric" pattern="[0-9]{5,40}" required autocomplete="off">
<label for="app_secret">Meta App Secret</label>
<input id="app_secret" name="app_secret" type="password" minlength="16" maxlength="256" required autocomplete="off" spellcheck="false">
<button type="submit">Enregistrer et connecter Facebook</button>
</form>
<p class="note">Le lien expire automatiquement et devient inutilisable après une configuration réussie.</p>
</main></body></html>`;
}

async function metaAppSetup(req, res, url) {
  if (req.method === 'GET') {
    const nonce = String(url.searchParams.get('setup') || '');

    if (!validMetaAppSetupNonce(nonce)) {
      res.statusCode = 410;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      metaAppSetupSecurityHeaders(res);
      return res.end(
        metaAppSetupPage({
          nonce: '',
          error: 'Lien invalide ou expiré.'
        })
      );
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    metaAppSetupSecurityHeaders(res);
    return res.end(metaAppSetupPage({ nonce }));
  }

  if (req.method !== 'POST') {
    return writeJson(res, 405, { error: 'method_not_allowed' });
  }

  const raw = await readRaw(req, 16 * 1024);
  const params = new URLSearchParams(raw.toString('utf8'));
  const nonce = String(params.get('setup') || '');
  const appId = String(params.get('app_id') || '').trim();
  const appSecret = String(params.get('app_secret') || '').trim();

  if (!validMetaAppSetupNonce(nonce)) {
    return writeJson(res, 410, { error: 'setup_link_expired' });
  }

  if (!/^[0-9]{5,40}$/.test(appId)) {
    res.statusCode = 400;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    metaAppSetupSecurityHeaders(res);
    return res.end(
      metaAppSetupPage({
        nonce,
        error: 'App ID invalide.'
      })
    );
  }

  if (
    appSecret.length < 16 ||
    appSecret.length > 256 ||
    /[\r\n]/.test(appSecret)
  ) {
    res.statusCode = 400;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    metaAppSetupSecurityHeaders(res);
    return res.end(
      metaAppSetupPage({
        nonce,
        error: 'App Secret invalide.'
      })
    );
  }

  persistMetaAppCredentials(appId, appSecret);

  config.appId = appId;
  config.appSecret = appSecret;

  let start;
  try {
    start = await createMetaOAuthStart({
      actor: 'owner-meta-setup',
      ttlSeconds: 600
    });
  } catch (error) {
    await audit('nexmeta.meta_app_setup.failed', 'web', {
      error: String(error?.message || error).slice(0, 400)
    }).catch(() => {});

    res.statusCode = 502;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    metaAppSetupSecurityHeaders(res);
    return res.end(
      metaAppSetupPage({
        nonce,
        error: 'Les identifiants ont été enregistrés, mais le démarrage OAuth a échoué. Vérifie la configuration de l’app Meta puis réessaie.'
      })
    );
  }

  try {
    fs.unlinkSync(META_APP_SETUP_FILE);
  } catch {}

  await audit('nexmeta.meta_app_setup.completed', 'web', {
    appId,
    oauthStarted: true
  }).catch(() => {});

  res.statusCode = 303;
  res.setHeader('location', start.authorizationUrl);
  metaAppSetupSecurityHeaders(res);
  return res.end();
}

const ownerConnectFailures = [];

function pruneOwnerConnectFailures() {
  const cutoff = Date.now() - 15 * 60 * 1000;

  while (
    ownerConnectFailures.length &&
    ownerConnectFailures[0] < cutoff
  ) {
    ownerConnectFailures.shift();
  }
}

function ownerConnectRateLimited() {
  pruneOwnerConnectFailures();
  return ownerConnectFailures.length >= 20;
}

function connectSecurityHeaders(res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-robots-tag', 'noindex, nofollow');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
}

function connectPageHtml({
  error = '',
  disabled = false
} = {}) {
  const connectAction = `${config.publicBaseUrl.replace(/\/+$/, '')}/connect/meta`
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  const message = disabled
    ? 'La connexion Facebook n’est pas encore prête. Vérifie l’URL HTTPS publique, l’App Meta, le verify token, la clé de chiffrement et NEXMETA_CONNECT_KEY avec pterodactyl/check.mjs.'
    : 'Entre la clé de connexion propriétaire configurée sur le serveur. Elle est envoyée uniquement en POST HTTPS et n’est jamais placée dans l’URL.';

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Connect Facebook · NexMeta</title>
<style>
html{background:#080808;color:#f4f4f4;font-family:system-ui,-apple-system,sans-serif}
body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px}
main{width:min(560px,100%);box-sizing:border-box;border:1px solid #2a2a2a;border-radius:24px;padding:32px;background:#111}
small{letter-spacing:.14em;text-transform:uppercase;color:#999}
h1{font-size:38px;margin:12px 0 8px;letter-spacing:-.04em}
p{color:#aaa;line-height:1.55}
label{display:block;margin:24px 0 8px;font-size:12px;color:#aaa;text-transform:uppercase;letter-spacing:.08em}
input{width:100%;box-sizing:border-box;background:#090909;color:#fff;border:1px solid #333;border-radius:14px;padding:14px 16px;font:inherit}
button{margin-top:12px;width:100%;border:0;border-radius:14px;padding:14px 16px;background:#f2f2f2;color:#090909;font:700 15px system-ui;cursor:pointer}
.err{color:#ffb0b0}
</style>
</head>
<body><main>
<small>NexMeta · Owner connection</small>
<h1>Connecter Facebook</h1>
<p>${message}</p>
${error ? `<p class="err">${String(error).replace(/[&<>]/g, '')}</p>` : ''}
${disabled ? '' : `
<form method="post" action="${connectAction}" autocomplete="off">
<label for="key">Clé propriétaire</label>
<input id="key" name="key" type="password" required autocomplete="off" spellcheck="false">
<button type="submit">Continuer avec Facebook</button>
</form>`}
</main></body></html>`;
}

async function ownerConnect(req, res) {
  const connectKeyReady =
    config.connectKey.length >= 24;

  const connectReady =
    connectKeyReady &&
    oauthConfigured() &&
    publicHttpsConfigured() &&
    Boolean(config.verifyToken);

  if (req.method === 'GET') {
    res.statusCode = connectReady ? 200 : 503;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    connectSecurityHeaders(res);
    return res.end(
      connectPageHtml({
        disabled: !connectReady
      })
    );
  }

  if (req.method !== 'POST') {
    return writeJson(res, 405, {
      error: 'method_not_allowed'
    });
  }

  if (!connectReady) {
    return writeJson(res, 503, {
      error: 'owner_connect_not_ready'
    });
  }

  if (ownerConnectRateLimited()) {
    res.setHeader('retry-after', '900');
    return writeJson(res, 429, {
      error: 'owner_connect_rate_limited'
    });
  }

  const raw = await readRaw(req, 16 * 1024);
  const contentType = String(
    req.headers['content-type'] || ''
  ).toLowerCase();

  let supplied = '';

  if (contentType.includes('application/x-www-form-urlencoded')) {
    supplied = new URLSearchParams(
      raw.toString('utf8')
    ).get('key') || '';
  } else {
    try {
      supplied = JSON.parse(raw.toString('utf8'))?.key || '';
    } catch {
      supplied = '';
    }
  }

  if (!authorizeControl(
    `Bearer ${String(supplied)}`,
    config.connectKey
  )) {
    ownerConnectFailures.push(Date.now());

    await audit('nexmeta.owner_connect.denied', 'web', {
      ok: false
    }).catch(() => {});

    res.statusCode = 403;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    connectSecurityHeaders(res);
    return res.end(
      connectPageHtml({
        error: 'Clé incorrecte.'
      })
    );
  }

  ownerConnectFailures.length = 0;

  const start = await createMetaOAuthStart({
    actor: 'owner-connect-page',
    ttlSeconds: 600
  });

  await audit('nexmeta.owner_connect.started', 'web', {
    ok: true
  }).catch(() => {});

  res.statusCode = 303;
  res.setHeader('location', start.authorizationUrl);
  connectSecurityHeaders(res);
  return res.end();
}

function companionHeaders(res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader(
    'access-control-allow-headers',
    'authorization, content-type'
  );
  res.setHeader(
    'access-control-allow-methods',
    'GET, POST, OPTIONS'
  );
}

async function companionApi(req, res, path) {
  companionHeaders(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  async function jsonBody(maxBytes = 256 * 1024) {
    const raw = await readRaw(req, maxBytes);
    if (!raw.length) return {};
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      const error = new Error('invalid_json');
      error.status = 400;
      throw error;
    }
  }

  try {
    if (req.method === 'POST' && path === '/companion/v1/pair') {
      const body = await jsonBody(32 * 1024);
      const result = await pairCompanion({
        pairCode: body?.pairCode,
        deviceName: body?.deviceName,
        platform: body?.platform,
        clientVersion: body?.clientVersion,
        capabilities: body?.capabilities
      });

      await audit('nexmeta.companion.paired', 'companion', {
        deviceId: result.deviceId,
        platform: String(body?.platform || '').slice(0, 80)
      }).catch(() => {});

      return writeJson(res, 200, {
        ok: true,
        result
      });
    }

    if (
      (req.method === 'GET' || req.method === 'POST') &&
      path === '/companion/v1/poll'
    ) {
      const body = req.method === 'POST'
        ? await jsonBody(64 * 1024)
        : {};

      const result = await pollCompanionCommands(
        req.headers.authorization,
        {
          limit: body?.limit,
          context: body?.context
        }
      );

      return writeJson(res, 200, {
        ok: true,
        result
      });
    }

    if (req.method === 'POST' && path === '/companion/v1/ack') {
      const body = await jsonBody(256 * 1024);
      const result = await acknowledgeCompanionCommand(
        req.headers.authorization,
        body
      );

      return writeJson(res, 200, {
        ok: true,
        result
      });
    }

    if (req.method === 'POST' && path === '/companion/v1/events') {
      const body = await jsonBody(512 * 1024);
      const result = await ingestCompanionEvents(
        req.headers.authorization,
        body
      );

      return writeJson(res, 200, {
        ok: true,
        result
      });
    }

    if (req.method === 'GET' && path === '/companion/v1/status') {
      const result = await companionDeviceStatus(
        req.headers.authorization
      );

      return writeJson(res, 200, {
        ok: true,
        result
      });
    }

    return writeJson(res, 404, {
      error: 'not_found'
    });
  } catch (error) {
    const status = Number(error?.status);
    return writeJson(
      res,
      status >= 400 && status <= 599 ? status : 500,
      {
        ok: false,
        error: String(error?.message || 'companion_error').slice(0, 300)
      }
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
    const [runtime, pages, account] = await Promise.all([
      getRuntimeSettings(),
      connectedPageState(),
      connectedAccountState()
    ]);

    await audit('nexmeta.status.read', 'nexcontrol');

    return writeJson(res, 200, {
      ok: true,
      service: 'nexmeta',
      version: '0.5.0',
      metaConfigured: metaConfigured(),
      oauthConfigured: oauthConfigured(),
      ownerConnectConfigured:
        config.connectKey.length >= 24,
      publicBaseUrlConfigured:
        Boolean(config.publicBaseUrl),
      runtime,
      pages,
      account,
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

    if (path.startsWith('/companion/v1/')) {
      return companionApi(req, res, path);
    }

    if (req.method === 'GET' && path === '/health') {
      await healthStore();

      const [runtime, pages, account] = await Promise.all([
        getRuntimeSettings(),
        connectedPageState(),
        connectedAccountState()
      ]);

      return writeJson(res, 200, {
        ok: true,
        service: 'nexmeta',
        version: '0.6.0',
        metaConfigured: metaConfigured(),
        oauthConfigured: oauthConfigured(),
        ownerConnectConfigured:
          config.connectKey.length >= 24,
        publicBaseUrlConfigured:
          Boolean(config.publicBaseUrl),
        runtime,
        pages,
        account
      });
    }

    if (path === '/setup/meta-app') {
      return metaAppSetup(req, res, url);
    }

    if (path === '/connect/meta') {
      return ownerConnect(req, res);
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
