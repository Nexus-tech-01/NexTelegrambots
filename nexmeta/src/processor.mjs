import {
  normalizeMessengerWebhook,
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
import { routeInbound } from './router.mjs';
import { sendText, senderAction } from './meta-client.mjs';

function extractLinkCode(text) {
  const value = String(text ?? '').trim().toUpperCase();

  const direct = value.match(/^(NXM-[A-Z0-9]{9})$/);
  if (direct) return direct[1];

  const command = value.match(/^(?:\/?LINK|\/?LIER)\s+(NXM-[A-Z0-9]{9})$/);
  return command ? command[1] : null;
}

async function sendAndSave(event, text) {
  const sent = await sendText(event.senderId, text);

  await saveMessage({
    platform: 'facebook',
    surface: 'messenger',
    pageId: event.pageId,
    externalUserId: event.senderId,
    externalMessageId: sent?.message_id || null,
    direction: 'outbound',
    text,
    timestamp: new Date()
  });

  return sent;
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

export async function processInboundEvent(event) {
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
    if (await tryIdentityLink(event)) return;

    const result = await routeInbound(event);

    if (result?.text) {
      await sendAndSave(event, result.text);
    }
  } finally {
    await senderAction(event.senderId, 'typing_off').catch(() => {});
  }
}

export async function processWebhookPayload(
  eventKey,
  payload,
  { throwOnFailure = false } = {}
) {
  try {
    const events = normalizeMessengerWebhook(payload);

    for (const event of events) {
      await processInboundEvent(event);
    }

    await markWebhookProcessed(eventKey, 'processed', null);

    return {
      ok: true,
      events: events.length
    };
  } catch (error) {
    console.error('[NexMeta webhook processor]', error);
    await markWebhookProcessed(eventKey, 'failed', error?.stack || error);

    if (throwOnFailure) throw error;

    return {
      ok: false,
      error: String(error?.message || error)
    };
  }
}

export { extractLinkCode };
