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

export async function callNexusGateway(event) {
  if (!config.nexusGatewayUrl) return null;

  const routing = classifyNexusRoute(event);
  const body = JSON.stringify(
    toNexusEnvelope(event, routing)
  );

  const response = await fetch(config.nexusGatewayUrl, {
    method: 'POST',
    headers: signedHeaders(body),
    body,
    signal: AbortSignal.timeout(20000)
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
    throw error;
  }

  return data;
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
    handledBy:
      gatewayResult.handledBy ||
      gatewayResult.service ||
      null,
    raw: gatewayResult
  };
}

export async function routeNexusEvent(event) {
  if (event?.isEcho) {
    return {
      handled: true,
      silent: true
    };
  }

  const gatewayResult = await callNexusGateway(event);

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

export async function routeInbound(event) {
  if (!['message', 'postback'].includes(event.type)) {
    return {
      handled: false
    };
  }

  return routeNexusEvent(event);
}
