import {
  normalizeMetaWebhook,
  eventIdentity
} from './normalizer.mjs';
import {
  markWebhookProcessed,
  upsertIdentity,
  saveMessage,
  audit,
  getRuntimeSettings
} from './store.mjs';
import { consumeIdentityLinkCode } from './identity-link.mjs';
import {
  routeInbound,
  routeNexusEvent
} from './router.mjs';
import {
  sendText,
  sendMedia,
  sendQuickReplies,
  sendTemplate,
  sendImageGallery,
  senderAction
} from './meta-client.mjs';

function extractLinkCode(text) {
  const value = String(text ?? '').trim().toUpperCase();

  const direct = value.match(/^(NXM-[A-Z0-9]{9})$/);
  if (direct) return direct[1];

  const command = value.match(
    /^(?:\/?LINK|\/?LIER)\s+(NXM-[A-Z0-9]{9})$/
  );

  return command ? command[1] : null;
}

async function saveOutbound(event, sent, {
  text = '',
  media = null
} = {}) {
  await saveMessage({
    platform: 'facebook',
    surface: 'messenger',
    pageId: event.pageId,
    externalUserId: event.senderId,
    externalMessageId: sent?.message_id || null,
    direction: 'outbound',
    text,
    media,
    timestamp: new Date()
  });
}

async function sendAndSave(event, text) {
  const sent = await sendText(event.senderId, text);
  await saveOutbound(event, sent, { text });
  return sent;
}

async function renderNexusReply(event, result) {
  if (!result || result.silent) return;

  const quickReplies = Array.isArray(result.quickReplies)
    ? result.quickReplies
    : [];

  if (result.text && quickReplies.length) {
    const sent = await sendQuickReplies(
      event.senderId,
      result.text,
      quickReplies
    );

    await saveOutbound(event, sent, {
      text: result.text
    });
  } else if (result.text) {
    await sendAndSave(event, result.text);
  }

  if (result.template && typeof result.template === 'object') {
    const sent = await sendTemplate(
      event.senderId,
      result.template
    );

    await saveOutbound(event, sent, {
      text: '[template]'
    });
  }

  if (Array.isArray(result.imageUrls) && result.imageUrls.length) {
    const sent = await sendImageGallery(
      event.senderId,
      result.imageUrls
    );

    await saveOutbound(event, sent, {
      media: {
        type: 'image_gallery',
        count: result.imageUrls.length
      }
    });
  }

  const media = result.media &&
    typeof result.media === 'object'
    ? result.media
    : null;

  if (media?.type && media?.url) {
    const sent = await sendMedia(
      event.senderId,
      String(media.type),
      String(media.url)
    );

    await saveOutbound(event, sent, {
      media: {
        type: String(media.type),
        url: String(media.url)
      }
    });
  }
}

async function tryIdentityLink(event) {
  if (event.type !== 'message') return false;

  const code = extractLinkCode(event.text);
  if (!code) return false;

  const result = await consumeIdentityLinkCode({
    code,
    pageId: event.pageId,
    externalUserId: event.senderId,
    platform: 'facebook'
  });

  if (!result) {
    await sendAndSave(
      event,
      'Ce code de liaison est invalide, expiré ou déjà utilisé. Génère un nouveau code depuis ton compte Nexus puis réessaie.'
    );

    await audit('nexmeta.identity.link_failed', 'messenger', {
      pageId: event.pageId,
      externalUserId: event.senderId,
      reason: 'invalid_expired_or_used_code'
    });

    return true;
  }

  await sendAndSave(
    event,
    'Compte Nexus lié avec succès. Tes accès et ta progression peuvent maintenant être partagés avec les services Nexus compatibles.'
  );

  await audit('nexmeta.identity.linked', 'messenger', {
    pageId: event.pageId,
    externalUserId: event.senderId,
    nexusUserId: result.nexusUserId
  });

  return true;
}

async function processPageEvent(event, settings) {
  if (!settings.inboundEnabled) {
    await audit('nexmeta.page_event.skipped', 'runtime', {
      reason: 'inbound_disabled',
      pageId: event.pageId,
      field: event.field,
      action: event.action
    });
    return;
  }

  const result = await routeNexusEvent(event);

  await audit('nexmeta.page_event.routed', 'facebook', {
    pageId: event.pageId,
    field: event.field,
    action: event.action,
    eventId: event.externalMessageId || null,
    handled: result?.handled === true,
    handledBy: result?.handledBy || null
  });
}

async function processMessengerEvent(event, settings) {
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

  if (event.isEcho) return;

  if (!settings.inboundEnabled) {
    await audit('nexmeta.inbound.skipped', 'runtime', {
      reason: 'inbound_disabled',
      pageId: event.pageId,
      senderId: event.senderId,
      eventType: event.type
    });
    return;
  }

  if (!['message', 'postback'].includes(event.type)) {
    const result = await routeNexusEvent(event);

    await audit('nexmeta.messenger_event.routed', 'facebook', {
      pageId: event.pageId,
      senderId: event.senderId,
      eventType: event.type,
      handled: result?.handled === true,
      handledBy: result?.handledBy || null
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
    if (await tryIdentityLink(event)) return;

    const result = await routeInbound(event);
    await renderNexusReply(event, result);
  } finally {
    await senderAction(event.senderId, 'typing_off').catch(() => {});
  }
}

export async function processInboundEvent(event) {
  const settings = await getRuntimeSettings();

  if (event.surface === 'page' && event.type === 'page_change') {
    return processPageEvent(event, settings);
  }

  if (event.surface === 'messenger') {
    return processMessengerEvent(event, settings);
  }
}

export async function processWebhookPayload(
  eventKey,
  payload,
  { throwOnFailure = false } = {}
) {
  try {
    const events = normalizeMetaWebhook(payload);

    for (const event of events) {
      await processInboundEvent(event);
    }

    await markWebhookProcessed(eventKey, 'processed', null);

    return {
      ok: true,
      events: events.length,
      messengerEvents: events.filter(
        event => event.surface === 'messenger'
      ).length,
      pageEvents: events.filter(
        event => event.surface === 'page'
      ).length
    };
  } catch (error) {
    console.error('[NexMeta webhook processor]', error);
    await markWebhookProcessed(
      eventKey,
      'failed',
      error?.stack || error
    );

    if (throwOnFailure) throw error;

    return {
      ok: false,
      error: String(error?.message || error)
    };
  }
}

export {
  extractLinkCode,
  renderNexusReply
};
