import crypto from 'node:crypto';
import { config } from './config.mjs';
import { toNexusEnvelope } from './normalizer.mjs';

function textOf(event) {
  return String(
    event?.text ||
    event?.payload ||
    event?.quickReplyPayload ||
    ''
  ).trim();
}

export function classifyNexusRoute(event) {
  if (event?.type === 'page_change') {
    if (event.field === 'feed') {
      return {
        intent: 'page_event',
        preferredService: 'nexcanal'
      };
    }

    return {
      intent: 'page_event',
      preferredService: 'auto'
    };
  }

  const text = textOf(event);

  const rules = [
    {
      pattern: /^NEXMETA_START$/i,
      intent: 'start',
      preferredService: 'auto'
    },
    {
      pattern: /^\/?(?:download|dl|video|audio|music|musique)\b/i,
      intent: 'download',
      preferredService: 'nexdownloader'
    },
    {
      pattern: /^\/?(?:game|play|quiz|jeu|jouer)\b/i,
      intent: 'game',
      preferredService: 'nexgame'
    },
    {
      pattern: /^\/?(?:sticker|stick|emoji|pack)\b/i,
      intent: 'sticker',
      preferredService: 'nexstick'
    },
    {
      pattern: /^\/?(?:group|groupe|moderation|admin)\b/i,
      intent: 'group',
      preferredService: 'nexgroup'
    },
    {
      pattern: /^\/?(?:channel|canal|publish|post|broadcast)\b/i,
      intent: 'channel',
      preferredService: 'nexcanal'
    },
    {
      pattern: /^\/?(?:ai|ask|nexai|stacy)\b/i,
      intent: 'assistant',
      preferredService: 'nexai'
    }
  ];

  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      return {
        intent: rule.intent,
        preferredService: rule.preferredService
      };
    }
  }

  return {
    intent: event?.type === 'postback' ? 'action' : 'conversation',
    preferredService: 'auto'
  };
}

function signedHeaders(body) {
  const headers = {
    'content-type': 'application/json'
  };

  if (!config.nexusGatewayKey) return headers;

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', config.nexusGatewayKey)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  headers.authorization = `Bearer ${config.nexusGatewayKey}`;
  headers['x-nexus-timestamp'] = timestamp;
  headers['x-nexus-signature'] = `sha256=${signature}`;

  return headers;
}

async function postNexusGatewayBody(body, timeoutMs = 20000) {
  const response = await fetch(config.nexusGatewayUrl, {
    method: 'POST',
    headers: signedHeaders(body),
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      text
    };
  }

  if (!response.ok) {
    const error = new Error(
      data?.error ||
      data?.message ||
      `Nexus gateway HTTP ${response.status}`
    );
    error.status = response.status;
    error.retryable = data?.retryable === true;
    throw error;
  }

  return data;
}

export async function probeNexusGateway() {
  if (!config.nexusGatewayUrl || !config.nexusGatewayKey) {
    return {
      ok: false,
      error: 'gateway_not_configured'
    };
  }

  const startedAt = Date.now();
  const body = JSON.stringify({
    version: 2,
    source: {
      platform: 'facebook',
      surface: 'system',
      pageId: null
    },
    user: {
      externalId: null,
      nexusUserId: null
    },
    routing: {
      intent: 'probe',
      preferredService: 'bridge'
    },
    event: {
      type: 'system_probe',
      id: null,
      timestamp: startedAt,
      text: '',
      attachments: [],
      payload: null,
      field: null,
      action: null,
      value: null
    }
  });

  try {
    const data = await postNexusGatewayBody(body, 5000);

    return {
      ok:
        data?.ok === true &&
        data?.probe === true &&
        data?.handledBy === 'nexus-bridge',
      latencyMs: Date.now() - startedAt,
      handledBy: data?.handledBy || null,
      availableServices: Array.isArray(data?.services?.available)
        ? data.services.available.map(String).sort()
        : []
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      status: Number(error?.status) || null,
      error: String(error?.message || 'gateway_probe_failed').slice(0, 160),
      availableServices: []
    };
  }
}

export async function fetchNexusBridgeStatus() {
  if (!config.nexusGatewayUrl || !config.nexusGatewayKey) {
    const error = new Error('gateway_not_configured');
    error.status = 503;
    throw error;
  }

  const url = new URL(config.nexusGatewayUrl);
  url.pathname = '/internal/nexus/bridge-status';
  url.search = '';

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${config.nexusGatewayKey}`
    },
    signal: AbortSignal.timeout(5000)
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      text: String(text || '').slice(0, 1000)
    };
  }

  if (!response.ok) {
    const error = new Error(
      data?.error ||
      `Nexus bridge status HTTP ${response.status}`
    );
    error.status = response.status;
    throw error;
  }

  return {
    ok: data?.ok === true,
    proxy: data?.proxy === true,
    childExited: data?.childExited === true,
    adapters: Array.isArray(data?.adapters)
      ? data.adapters
      : [],
    discovery: data?.discovery &&
      typeof data.discovery === 'object'
      ? data.discovery
      : null
  };
}

export async function callNexusGateway(event, context = {}) {
  if (!config.nexusGatewayUrl) return null;

  const routing = classifyNexusRoute(event);
  const body = JSON.stringify(
    toNexusEnvelope(event, routing, context.identity || {})
  );

  return postNexusGatewayBody(body);
}

function normalizeGatewayReply(gatewayResult) {
  if (!gatewayResult) return null;

  const reply = gatewayResult.reply &&
    typeof gatewayResult.reply === 'object'
    ? gatewayResult.reply
    : gatewayResult;

  return {
    text: typeof reply.text === 'string'
      ? reply.text
      : null,
    media: reply.media &&
      typeof reply.media === 'object'
      ? reply.media
      : null,
    quickReplies: Array.isArray(reply.quickReplies)
      ? reply.quickReplies
      : [],
    template: reply.template &&
      typeof reply.template === 'object'
      ? reply.template
      : null,
    imageUrls: Array.isArray(reply.imageUrls)
      ? reply.imageUrls
      : [],
    handledBy:
      gatewayResult.handledBy ||
      gatewayResult.service ||
      null,
    raw: gatewayResult
  };
}

export async function routeNexusEvent(event, context = {}) {
  if (event?.isEcho) {
    return {
      handled: true,
      silent: true
    };
  }

  const gatewayResult = await callNexusGateway(event, context);

  if (gatewayResult) {
    return {
      handled: true,
      ...normalizeGatewayReply(gatewayResult)
    };
  }

  if (event?.type === 'page_change') {
    return {
      handled: false,
      silent: true
    };
  }

  const text = textOf(event);

  if (/^\/?ping$/i.test(text)) {
    return {
      handled: true,
      text: 'NexMeta online.'
    };
  }

  if (/^(?:NEXMETA_START|\/?(?:start|help))$/i.test(text)) {
    return {
      handled: true,
      text: 'NexMeta est connecté. Choisis un service Nexus ou écris directement ce que tu veux faire.',
      quickReplies: [
        { title: 'Download', payload: '/download' },
        { title: 'Games', payload: '/game' },
        { title: 'Stickers', payload: '/sticker' },
        { title: 'Nexus AI', payload: '/ai' }
      ]
    };
  }

  return {
    handled: true,
    text: 'NexMeta a reçu ton message. Le gateway Nexus commun n’est pas encore configuré sur ce déploiement.'
  };
}

export async function routeInbound(event, context = {}) {
  if (!['message', 'postback'].includes(event.type)) {
    return {
      handled: false
    };
  }

  return routeNexusEvent(event, context);
}
