export function normalizeMessengerWebhook(payload) {
  const events = [];
  if (!payload || payload.object !== 'page' || !Array.isArray(payload.entry)) return events;

  for (const entry of payload.entry) {
    for (const item of entry.messaging || []) {
      const senderId = String(item.sender?.id || '');
      const recipientId = String(item.recipient?.id || entry.id || '');
      const base = {
        platform: 'facebook',
        surface: 'messenger',
        pageId: String(entry.id || recipientId),
        senderId,
        recipientId,
        timestamp: Number(item.timestamp || Date.now()),
        raw: item
      };

      if (item.message) {
        events.push({
          ...base,
          type: 'message',
          externalMessageId: item.message.mid ? String(item.message.mid) : null,
          text: typeof item.message.text === 'string' ? item.message.text : '',
          attachments: Array.isArray(item.message.attachments) ? item.message.attachments : [],
          quickReplyPayload: item.message.quick_reply?.payload || null,
          isEcho: Boolean(item.message.is_echo)
        });
        continue;
      }

      if (item.postback) {
        events.push({
          ...base,
          type: 'postback',
          externalMessageId: item.postback.mid ? String(item.postback.mid) : null,
          payload: item.postback.payload || '',
          title: item.postback.title || ''
        });
        continue;
      }

      if (item.read) events.push({ ...base, type: 'read', watermark: item.read.watermark || null });
      else if (item.delivery) events.push({ ...base, type: 'delivery', mids: item.delivery.mids || [] });
      else events.push({ ...base, type: 'unknown' });
    }
  }

  return events;
}

export function eventIdentity(event) {
  return {
    platform: event.platform,
    externalUserId: event.senderId,
    pageId: event.pageId
  };
}

export function toNexusEnvelope(event) {
  return {
    version: 1,
    source: {
      platform: event.platform,
      surface: event.surface,
      pageId: event.pageId
    },
    user: { externalId: event.senderId },
    event: {
      type: event.type,
      id: event.externalMessageId,
      timestamp: event.timestamp,
      text: event.text || '',
      attachments: event.attachments || [],
      payload: event.payload || event.quickReplyPayload || null
    }
  };
}
