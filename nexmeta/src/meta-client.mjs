import { config, assertMetaSendConfig } from './config.mjs';

function graphBase() {
  assertMetaSendConfig();
  return `https://graph.facebook.com/${config.graphVersion}`;
}

function graphPath(idOrPath) {
  return String(idOrPath)
    .split('/')
    .filter(Boolean)
    .map(part => encodeURIComponent(part))
    .join('/');
}

function parseLimit(value, fallback = 25, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

async function graphRequest(
  path,
  { method = 'GET', query = {}, body, bodyMode = 'json' } = {}
) {
  const url = new URL(`${graphBase()}/${graphPath(path)}`);

  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const headers = {
    authorization: `Bearer ${config.pageAccessToken}`
  };

  let payload;
  if (body !== undefined && body !== null) {
    if (bodyMode === 'form') {
      headers['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8';
      payload = new URLSearchParams(
        Object.entries(body)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)])
      ).toString();
    } else {
      headers['content-type'] = 'application/json; charset=utf-8';
      payload = JSON.stringify(body);
    }
  }

  const response = await fetch(url, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(15000)
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.error?.message || `Meta API HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.metaCode = data?.error?.code;
    error.metaSubcode = data?.error?.error_subcode;
    error.metaType = data?.error?.type;
    throw error;
  }

  return data;
}

export async function getPageProfile() {
  return graphRequest(config.pageId, {
    query: {
      fields: 'id,name,username,link,category,picture'
    }
  });
}

export async function sendText(psid, text, messagingType = 'RESPONSE') {
  if (!psid || !text) throw new Error('psid and text are required');

  return graphRequest(`${config.pageId}/messages`, {
    method: 'POST',
    body: {
      recipient: { id: String(psid) },
      messaging_type: messagingType,
      message: { text: String(text).slice(0, 2000) }
    }
  });
}

export async function sendMedia(psid, type, url, messagingType = 'RESPONSE') {
  if (!psid || !url) throw new Error('psid and url are required');
  if (!['image', 'audio', 'video', 'file'].includes(type)) {
    throw new Error('unsupported media type');
  }

  return graphRequest(`${config.pageId}/messages`, {
    method: 'POST',
    body: {
      recipient: { id: String(psid) },
      messaging_type: messagingType,
      message: {
        attachment: {
          type,
          payload: {
            url: String(url),
            is_reusable: true
          }
        }
      }
    }
  });
}

export async function sendQuickReplies(psid, text, quickReplies, messagingType = 'RESPONSE') {
  if (!psid || !text) throw new Error('psid and text are required');
  if (!Array.isArray(quickReplies) || quickReplies.length < 1 || quickReplies.length > 13) {
    throw new Error('quickReplies must contain between 1 and 13 items');
  }

  const normalized = quickReplies.map(item => ({
    content_type: 'text',
    title: String(item.title || '').slice(0, 20),
    payload: String(item.payload || '').slice(0, 1000),
    ...(item.imageUrl ? { image_url: String(item.imageUrl) } : {})
  }));

  if (normalized.some(item => !item.title || !item.payload)) {
    throw new Error('each quick reply needs title and payload');
  }

  return graphRequest(`${config.pageId}/messages`, {
    method: 'POST',
    body: {
      recipient: { id: String(psid) },
      messaging_type: messagingType,
      message: {
        text: String(text).slice(0, 2000),
        quick_replies: normalized
      }
    }
  });
}

export async function senderAction(psid, action) {
  if (!['mark_seen', 'typing_on', 'typing_off'].includes(action)) {
    throw new Error('unsupported sender action');
  }

  return graphRequest(`${config.pageId}/messages`, {
    method: 'POST',
    body: {
      recipient: { id: String(psid) },
      sender_action: action
    }
  });
}

export async function listConversations({ limit = 25, after } = {}) {
  return graphRequest(`${config.pageId}/conversations`, {
    query: {
      platform: 'messenger',
      fields: 'id,updated_time,message_count,participants',
      limit: parseLimit(limit),
      after
    }
  });
}

export async function listConversationMessages(conversationId, { limit = 25, after } = {}) {
  if (!conversationId) throw new Error('conversationId is required');

  return graphRequest(`${conversationId}/messages`, {
    query: {
      fields: 'id,created_time,from,to,message,attachments',
      limit: parseLimit(limit),
      after
    }
  });
}

export async function getMessage(messageId) {
  if (!messageId) throw new Error('messageId is required');

  return graphRequest(messageId, {
    query: {
      fields: 'id,created_time,from,to,message,attachments'
    }
  });
}

export async function publishPagePost({
  message = '',
  link,
  published = true,
  scheduledPublishTime
} = {}) {
  if (!String(message).trim() && !link) {
    throw new Error('message or link is required');
  }

  const schedule = scheduledPublishTime
    ? Math.trunc(new Date(scheduledPublishTime).getTime() / 1000)
    : undefined;

  if (scheduledPublishTime && !Number.isFinite(schedule)) {
    throw new Error('invalid scheduledPublishTime');
  }

  return graphRequest(`${config.pageId}/feed`, {
    method: 'POST',
    bodyMode: 'form',
    body: {
      message: String(message),
      link: link ? String(link) : undefined,
      published: schedule ? false : Boolean(published),
      scheduled_publish_time: schedule
    }
  });
}

export async function editObjectMessage(objectId, message) {
  if (!objectId || !String(message).trim()) {
    throw new Error('objectId and message are required');
  }

  return graphRequest(objectId, {
    method: 'POST',
    bodyMode: 'form',
    body: { message: String(message) }
  });
}

export async function deleteObject(objectId) {
  if (!objectId) throw new Error('objectId is required');
  return graphRequest(objectId, { method: 'DELETE' });
}

export async function listComments(objectId, { limit = 25, after } = {}) {
  if (!objectId) throw new Error('objectId is required');

  return graphRequest(`${objectId}/comments`, {
    query: {
      fields: 'id,message,created_time,from,can_hide,can_remove,can_comment,is_hidden,comment_count',
      filter: 'stream',
      order: 'reverse_chronological',
      limit: parseLimit(limit),
      after
    }
  });
}

export async function replyToComment(commentId, message) {
  if (!commentId || !String(message).trim()) {
    throw new Error('commentId and message are required');
  }

  return graphRequest(`${commentId}/comments`, {
    method: 'POST',
    bodyMode: 'form',
    body: { message: String(message) }
  });
}

export async function setCommentHidden(commentId, isHidden) {
  if (!commentId) throw new Error('commentId is required');

  return graphRequest(commentId, {
    method: 'POST',
    bodyMode: 'form',
    body: { is_hidden: Boolean(isHidden) }
  });
}

export { parseLimit };
