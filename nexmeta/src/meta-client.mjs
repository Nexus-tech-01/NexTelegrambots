import crypto from 'node:crypto';
import { config, assertGraphConfig } from './config.mjs';
import {
  getActivePageCredential,
  getPageCredential
} from './token-vault.mjs';

function graphBase() {
  assertGraphConfig();
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

function appSecretProof(accessToken) {
  if (!config.appSecret) return null;

  return crypto
    .createHmac('sha256', config.appSecret)
    .update(accessToken)
    .digest('hex');
}

async function graphRequest(
  path,
  {
    method = 'GET',
    query = {},
    body,
    bodyMode = 'json',
    credential
  } = {}
) {
  const active = credential || await getActivePageCredential();
  const url = new URL(`${graphBase()}/${graphPath(path)}`);

  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const proof = appSecretProof(active.pageAccessToken);
  if (proof && !url.searchParams.has('appsecret_proof')) {
    url.searchParams.set('appsecret_proof', proof);
  }

  const headers = {
    authorization: `Bearer ${active.pageAccessToken}`
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

  if (!response.ok || data?.error) {
    const message = data?.error?.message || `Meta API HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status >= 400 ? response.status : 502;
    error.metaCode = data?.error?.code;
    error.metaSubcode = data?.error?.error_subcode;
    error.metaType = data?.error?.type;
    throw error;
  }

  return data;
}

async function pagePath(edge = '', pageId) {
  const id = String(pageId || '').trim();
  const credential = id
    ? await getPageCredential(id)
    : await getActivePageCredential();

  return {
    credential,
    path: edge
      ? `${credential.pageId}/${edge.replace(/^\/+/, '')}`
      : credential.pageId
  };
}

export async function getPageProfile(pageId) {
  const { credential, path } = await pagePath('', pageId);

  return graphRequest(path, {
    credential,
    query: {
      fields: 'id,name,username,link,category,picture'
    }
  });
}

export async function sendText(
  psid,
  text,
  messagingType = 'RESPONSE',
  pageId
) {
  if (!psid || !text) throw new Error('psid and text are required');

  const { credential, path } = await pagePath('messages', pageId);

  return graphRequest(path, {
    credential,
    method: 'POST',
    body: {
      recipient: { id: String(psid) },
      messaging_type: messagingType,
      message: { text: String(text).slice(0, 2000) }
    }
  });
}

export async function sendMedia(
  psid,
  type,
  url,
  messagingType = 'RESPONSE',
  pageId
) {
  if (!psid || !url) throw new Error('psid and url are required');
  if (!['image', 'audio', 'video', 'file'].includes(type)) {
    throw new Error('unsupported media type');
  }

  const { credential, path } = await pagePath('messages', pageId);

  return graphRequest(path, {
    credential,
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

export async function sendQuickReplies(
  psid,
  text,
  quickReplies,
  messagingType = 'RESPONSE',
  pageId
) {
  if (!psid || !text) throw new Error('psid and text are required');

  if (
    !Array.isArray(quickReplies) ||
    quickReplies.length < 1 ||
    quickReplies.length > 13
  ) {
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

  const { credential, path } = await pagePath('messages', pageId);

  return graphRequest(path, {
    credential,
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

export async function senderAction(psid, action, pageId) {
  if (!['mark_seen', 'typing_on', 'typing_off'].includes(action)) {
    throw new Error('unsupported sender action');
  }

  const { credential, path } = await pagePath('messages', pageId);

  return graphRequest(path, {
    credential,
    method: 'POST',
    body: {
      recipient: { id: String(psid) },
      sender_action: action
    }
  });
}

export async function listConversations({
  limit = 25,
  after,
  pageId
} = {}) {
  const { credential, path } = await pagePath(
    'conversations',
    pageId
  );

  return graphRequest(path, {
    credential,
    query: {
      platform: 'messenger',
      fields: 'id,updated_time,message_count,participants',
      limit: parseLimit(limit),
      after
    }
  });
}

export async function listConversationMessages(
  conversationId,
  { limit = 25, after, pageId } = {}
) {
  if (!conversationId) throw new Error('conversationId is required');

  const { credential } = await pagePath('', pageId);

  return graphRequest(`${conversationId}/messages`, {
    credential,
    query: {
      fields: 'id,created_time,from,to,message,attachments',
      limit: parseLimit(limit),
      after
    }
  });
}

export async function getMessage(messageId, pageId) {
  if (!messageId) throw new Error('messageId is required');

  const { credential } = await pagePath('', pageId);

  return graphRequest(messageId, {
    credential,
    query: {
      fields: 'id,created_time,from,to,message,attachments'
    }
  });
}

export async function publishPagePost({
  message = '',
  link,
  published = true,
  scheduledPublishTime,
  pageId
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

  const { credential, path } = await pagePath(
    'feed',
    pageId
  );

  return graphRequest(path, {
    credential,
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

export async function editObjectMessage(
  objectId,
  message,
  pageId
) {
  if (!objectId || !String(message).trim()) {
    throw new Error('objectId and message are required');
  }

  const { credential } = await pagePath('', pageId);

  return graphRequest(objectId, {
    credential,
    method: 'POST',
    bodyMode: 'form',
    body: {
      message: String(message)
    }
  });
}

export async function deleteObject(objectId, pageId) {
  if (!objectId) throw new Error('objectId is required');

  const { credential } = await pagePath('', pageId);

  return graphRequest(objectId, {
    credential,
    method: 'DELETE'
  });
}

export async function listComments(
  objectId,
  { limit = 25, after, pageId } = {}
) {
  if (!objectId) throw new Error('objectId is required');

  const { credential } = await pagePath('', pageId);

  return graphRequest(`${objectId}/comments`, {
    credential,
    query: {
      fields: 'id,message,created_time,from,can_hide,can_remove,can_comment,is_hidden,comment_count',
      filter: 'stream',
      order: 'reverse_chronological',
      limit: parseLimit(limit),
      after
    }
  });
}

export async function replyToComment(
  commentId,
  message,
  pageId
) {
  if (!commentId || !String(message).trim()) {
    throw new Error('commentId and message are required');
  }

  const { credential } = await pagePath('', pageId);

  return graphRequest(`${commentId}/comments`, {
    credential,
    method: 'POST',
    bodyMode: 'form',
    body: {
      message: String(message)
    }
  });
}

export async function setCommentHidden(
  commentId,
  isHidden,
  pageId
) {
  if (!commentId) throw new Error('commentId is required');

  const { credential } = await pagePath('', pageId);

  return graphRequest(commentId, {
    credential,
    method: 'POST',
    bodyMode: 'form',
    body: {
      is_hidden: Boolean(isHidden)
    }
  });
}

export async function getMessengerUserProfile(psid, pageId) {
  const id = String(psid || '').trim();
  if (!id) throw new Error('psid is required');

  const { credential } = await pagePath('', pageId);

  return graphRequest(id, {
    credential,
    query: {
      fields: 'id,first_name,last_name,name,profile_pic,locale'
    }
  });
}

export async function moderateConversation(
  psid,
  action,
  pageId
) {
  const id = String(psid || '').trim();
  if (!id) throw new Error('psid is required');

  const allowed = new Set([
    'block_user',
    'unblock_user',
    'ban_user',
    'unban_user',
    'move_to_spam'
  ]);

  if (!allowed.has(String(action))) {
    throw new Error('unsupported moderation action');
  }

  const { credential, path } = await pagePath(
    'moderate_conversations',
    pageId
  );

  return graphRequest(path, {
    credential,
    method: 'POST',
    body: {
      user_ids: [{ id }],
      actions: [String(action)]
    }
  });
}

export async function sendTemplate(
  psid,
  templatePayload,
  messagingType = 'RESPONSE',
  pageId
) {
  if (!psid) throw new Error('psid is required');
  if (!templatePayload || typeof templatePayload !== 'object') {
    throw new Error('templatePayload is required');
  }

  const { credential, path } = await pagePath('messages', pageId);

  return graphRequest(path, {
    credential,
    method: 'POST',
    body: {
      recipient: { id: String(psid) },
      messaging_type: messagingType,
      message: {
        attachment: {
          type: 'template',
          payload: templatePayload
        }
      }
    }
  });
}

export async function sendButtonTemplate(
  psid,
  text,
  buttons,
  messagingType = 'RESPONSE',
  pageId
) {
  if (!String(text || '').trim()) throw new Error('text is required');
  if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 3) {
    throw new Error('buttons must contain between 1 and 3 items');
  }

  return sendTemplate(
    psid,
    {
      template_type: 'button',
      text: String(text).slice(0, 640),
      buttons
    },
    messagingType,
    pageId
  );
}

export async function sendImageGallery(
  psid,
  imageUrls,
  messagingType = 'RESPONSE',
  pageId
) {
  if (!psid) throw new Error('psid is required');
  if (!Array.isArray(imageUrls) || imageUrls.length < 1 || imageUrls.length > 30) {
    throw new Error('imageUrls must contain between 1 and 30 images');
  }

  const { credential, path } = await pagePath('messages', pageId);

  return graphRequest(path, {
    credential,
    method: 'POST',
    body: {
      recipient: { id: String(psid) },
      messaging_type: messagingType,
      message: {
        attachments: imageUrls.map(url => ({
          type: 'image',
          payload: {
            url: String(url)
          }
        }))
      }
    }
  });
}

export { parseLimit };
