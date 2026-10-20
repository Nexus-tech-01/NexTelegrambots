// Pairing-specific identity and browser-origin checks.
// This module never authorizes access to the administration APIs.
export function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

export function phoneFromWhatsAppCredentials(credentials) {
  const jid = String(credentials?.me?.id || '');
  const digits = normalizePhone(jid.split('@')[0].split(':')[0]);
  return /^\d{7,15}$/.test(digits) ? digits : '';
}

export function isSameOriginPairingRequest(origin, host) {
  try {
    if (!origin || !host) return false;
    const uri = new URL(origin);
    return (uri.protocol === 'https:' || uri.hostname === 'localhost') &&
      uri.host.toLowerCase() === String(host).toLowerCase();
  } catch { return false; }
}

export function isAuthorizedWhatsAppPhone(requested, approved) {
  const phone = normalizePhone(requested);
  return Boolean(/^\d{7,15}$/.test(phone) && approved && phone === normalizePhone(approved));
}
