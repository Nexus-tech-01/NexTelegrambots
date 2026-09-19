function baseEntry(entry) {
  return {
    platform: 'facebook',
    pageId: String(entry?.id || ''),
    timestamp: Number(entry?.time ? Number(entry.time) * 1000 : Date.now())
  };
}

export function normalizeMetaWebhook(payload) {
  const events = [];
  if (!payload || payload.object !== 'page' || !Array.isArray(payload.entry)) {
    return events;
  }

  for (const entry of payload.entry) {
    const entryBase = baseEntry(entry);

    for (const item of entry.messaging || []) {
      const senderId = String(item.sender?.id || '');
      const recipientId = String(item.recipient?.id || entry.id || '');

      const base = {
        ...entryBase,
        surface: 'messenger',
        pageId: String(entry.id || recipientId),
        senderId,
        recipientId,
        timestamp: Number(item.timestamp || entryBase.timestamp),
        raw: item
      };

      if (item.message) {
        events.push({
          ...base,
          type: 'message',
          externalMessageId: item.message.mid
            ? String(item.message.mid)
            : null,
          text: typeof item.message.text === 'string'
            ? item.message.text
            : '',
          attachments: Array.isArray(item.message.attachments)
            ? item.message.attachments
            : [],
          quickReplyPayload: item.message.quick_reply?.payload || null,
          isEcho: Boolean(item.message.is_echo)
        });
        continue;
      }

      if (item.postback) {
        events.push({
          ...base,
          type: 'postback',
          externalMessageId: item.postback.mid
            ? String(item.postback.mid)
            : null,
          payload: item.postback.payload || '',
          title: item.postback.title || ''
        });
        continue;
      }

      if (item.reaction) {
        events.push({
          ...base,
          type: 'reaction',
          externalMessageId: item.reaction.mid
            ? String(item.reaction.mid)
            : null,
          action: item.reaction.action || '',
          reaction: item.reaction.reaction || '',
          emoji: item.reaction.emoji || ''
        });
      } else if (item.read) {
        events.push({
          ...base,
          type: 'read',
          watermark: item.read.watermark || null
        });
      } else if (item.delivery) {
        events.push({
          ...base,
          type: 'delivery',
          mids: item.delivery.mids || []
        });
      } else {
        events.push({
          ...base,
          type: 'unknown'
        });
      }
    }

    for (const change of entry.changes || []) {
      const value = change?.value || {};
      const senderId = String(
        value?.sender_id ||
        value?.from?.id ||
        value?.user_id ||
        ''
      );

      events.push({
        ...entryBase,
        surface: 'page',
        type: 'page_change',
        field: String(change?.field || ''),
        action: String(value?.verb || value?.item || ''),
        senderId,
        externalMessageId:
          value?.comment_id ||
          value?.post_id ||
          value?.photo_id ||
          value?.video_id ||
          null,
        text: typeof value?.message === 'string'
          ? value.message
          : '',
        value,
        raw: change
      });
    }
  }

  return events;
}

export function normalizeMessengerWebhook(payload) {
  return normalizeMetaWebhook(payload).filter(
    event => event.surface === 'messenger'
  );
}

export function eventIdentity(event) {
  return {
    platform: event.platform,
    externalUserId: event.senderId,
    pageId: event.pageId
  };
}

export function toNexusEnvelope(event, routing = {}) {
  return {
    version: 2,
    source: {
      platform: event.platform,
      surface: event.surface,
      pageId: event.pageId
    },
    user: {
      externalId: event.senderId || null
    },
    routing: {
      intent: routing.intent || 'auto',
      preferredService: routing.preferredService || 'auto'
    },
    event: {
      type: event.type,
      id: event.externalMessageId,
      timestamp: event.timestamp,
      text: event.text || '',
      attachments: event.attachments || [],
      payload: event.payload || event.quickReplyPayload || null,
      field: event.field || null,
      action: event.action || null,
      value: event.type === 'page_change'
        ? event.value || null
        : null
    }
  };
}
