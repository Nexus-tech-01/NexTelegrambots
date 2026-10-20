import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export function isExpectedTelegramOwnerChat(chat, ownerChatId, ownerUsername) {
  const normalized = String(ownerUsername || '').replace(/^@/, '').toLowerCase().trim();
  return Boolean(
    chat && chat.type === 'private' &&
    /^\d+$/.test(String(ownerChatId || '')) &&
    String(chat.id) === String(ownerChatId) &&
    String(chat.username || '').toLowerCase() === normalized &&
    normalized === 'tresor20001'
  );
}


// A passwordless owner sign-in. Only the configured Telegram chat receives codes.
// Never return a code to the requesting browser or write it to application logs.
export function createTelegramOwnerOtp({
  telegramBotToken,
  ownerChatId,
  ownerUsername,
  sessionSecret,
  deliver,
  now = () => Date.now(),
  generateCode = () => String(randomInt(0, 100_000_000)).padStart(8, '0'),
}) {
  const enabled = Boolean(telegramBotToken && /^\d+$/.test(String(ownerChatId || '')) && ownerUsername === 'tresor20001' && sessionSecret);
  const lifetimeMs = 5 * 60_000;
  const cooldownMs = 60_000;
  let challenge = null;
  let nextRequestAt = 0;

  function digest(value) {
    return createHmac('sha256', sessionSecret).update(String(value)).digest();
  }

  async function requestCode() {
    if (!enabled) {
      return { ok: false, status: 503, error: 'Connexion Telegram non configurée pour cet administrateur.' };
    }
    const current = now();
    if (current < nextRequestAt) {
      return { ok: false, status: 429, error: 'Un code a déjà été demandé. Réessaie dans une minute.' };
    }
    // Set the rate limit before making a network call to prevent overlapping requests.
    nextRequestAt = current + cooldownMs;
    const code = generateCode();
    if (!/^\d{8}$/.test(code)) throw new Error('Invalid OTP generator');
    challenge = { hash: digest(code), expiresAt: current + lifetimeMs, remainingAttempts: 5 };
    try {
      await deliver({ telegramBotToken, ownerChatId, ownerUsername, code });
    } catch {
      challenge = null;
      return { ok: false, status: 503, error: 'Impossible de transmettre le code au compte Telegram administrateur.' };
    }
    return { ok: true, expiresInSeconds: lifetimeMs / 1000 };
  }

  function verifyCode(rawCode) {
    if (!enabled || !challenge) return false;
    const current = now();
    if (current >= challenge.expiresAt || challenge.remainingAttempts <= 0) {
      challenge = null;
      return false;
    }
    challenge.remainingAttempts -= 1;
    const code = String(rawCode || '').trim();
    const valid = /^\d{8}$/.test(code) && timingSafeEqual(digest(code), challenge.hash);
    if (valid || challenge.remainingAttempts === 0) challenge = null;
    return valid;
  }

  return { enabled, requestCode, verifyCode };
}
