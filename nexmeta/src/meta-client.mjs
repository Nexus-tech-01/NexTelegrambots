import { config, assertMetaSendConfig } from './config.mjs';

function endpoint(path) {
  assertMetaSendConfig();
  return `https://graph.facebook.com/${config.graphVersion}/${path}`;
}

async function request(path, body) {
  const response = await fetch(endpoint(path), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.pageAccessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }

  if (!response.ok) {
    const message = data?.error?.message || `Meta API HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.metaCode = data?.error?.code;
    throw error;
  }
  return data;
}

export async function sendText(psid, text, messagingType = 'RESPONSE') {
  if (!psid || !text) throw new Error('psid and text are required');
  return request(`${config.pageId}/messages`, {
    recipient: { id: String(psid) },
    messaging_type: messagingType,
    message: { text: String(text).slice(0, 2000) }
  });
}

export async function senderAction(psid, action) {
  if (!['mark_seen', 'typing_on', 'typing_off'].includes(action)) {
    throw new Error('unsupported sender action');
  }
  return request(`${config.pageId}/messages`, {
    recipient: { id: String(psid) },
    sender_action: action
  });
}
