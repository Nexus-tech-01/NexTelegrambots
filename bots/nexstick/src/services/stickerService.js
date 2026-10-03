'use strict';

const BOT_TOKEN = String(process.env.NEXSTICK__BOT_TOKEN || process.env.NEXSTICK_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();

async function telegramJson(method, body = {}, timeoutMs = 30000) {
  if (!BOT_TOKEN) throw new Error('NexStick BOT_TOKEN absent');
  const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    const error = new Error(data?.description || ('Telegram ' + method + ' HTTP ' + response.status));
    error.status = response.status;
    error.telegram = data;
    error.retryAfter = Number(data?.parameters?.retry_after || 0);
    throw error;
  }
  return data.result;
}

function stickerFormat(sticker) {
  if (sticker?.is_video) return 'video';
  if (sticker?.is_animated) return 'animated';
  return 'static';
}

async function getStickerSet(name) {
  return telegramJson('getStickerSet', { name });
}

async function getFile(fileId) {
  return telegramJson('getFile', { file_id: fileId });
}

module.exports = { telegramJson, stickerFormat, getStickerSet, getFile };
