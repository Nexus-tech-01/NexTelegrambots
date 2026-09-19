import crypto from 'node:crypto';

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function verifyWebhookChallenge(searchParams, verifyToken) {
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');
  if (mode !== 'subscribe' || !challenge || !verifyToken || !safeEqual(token, verifyToken)) {
    return { ok: false };
  }
  return { ok: true, challenge };
}

export function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || !signatureHeader) return false;
  const [algorithm, supplied] = String(signatureHeader).split('=', 2);
  if (algorithm !== 'sha256' || !supplied) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(supplied.toLowerCase(), expected.toLowerCase());
}

export function authorizeControl(authHeader, controlKey) {
  if (!controlKey) return false;
  const supplied = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
  return Boolean(supplied) && safeEqual(supplied, controlKey);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
