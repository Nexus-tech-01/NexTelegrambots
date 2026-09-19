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
import { routeInbound } from './router.mjs';
import { sendText, senderAction } from './meta-client.mjs';

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

export async function processWebhookPayload(eventKey, payload, { throwOnFailure = false } = {}) {
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
