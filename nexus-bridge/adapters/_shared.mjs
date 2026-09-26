import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const nexusRoot = path.resolve(process.env.NEXUS_ROOT || process.cwd());

export function liveModule(...segments) {
  return pathToFileURL(path.join(nexusRoot, ...segments)).href;
}

export function eventText(envelope) {
  return String(envelope?.event?.text || envelope?.event?.payload || '').trim();
}

export function actorId(envelope) {
  return String(envelope?.user?.nexusUserId || '').trim();
}

export function externalUserId(envelope) {
  return String(envelope?.user?.externalId || '').trim();
}

export function languageOf(envelope) {
  const raw = String(envelope?.user?.language || envelope?.context?.language || process.env.NEXMETA_DEFAULT_LANGUAGE || 'fr').toLowerCase();
  return raw.startsWith('en') ? 'en' : 'fr';
}

export function tokenize(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

export function stripCommand(text) {
  const parts = tokenize(text);
  parts.shift();
  return parts;
}

export function privilegedIds() {
  return new Set(
    [
      process.env.NEXUS_OWNER_TELEGRAM_ID,
      process.env.NEXGROUP__NEXGROUP_OWNER_ID,
      process.env.NEXGROUP_OWNER_ID,
      process.env.NEXDOWNLOADER__OWNER_TELEGRAM_ID,
      process.env.STACY__OWNER_TELEGRAM_ID,
      ...(String(process.env.NEXMETA_PRIVILEGED_NEXUS_IDS || '').split(/[\s,;|]+/))
    ].map(x => String(x || '').trim()).filter(Boolean)
  );
}

export function requirePrivileged(envelope) {
  const id = actorId(envelope);
  if (!id) {
    const e = new Error('identity_link_required');
    e.status = 403;
    throw e;
  }
  if (!privilegedIds().has(id)) {
    const e = new Error('nexus_permission_denied');
    e.status = 403;
    throw e;
  }
  return id;
}

export function telegramNumericActor(envelope) {
  const id = requirePrivileged(envelope);
  if (!/^-?\d+$/.test(id)) {
    const e = new Error('linked_nexus_identity_is_not_a_telegram_id');
    e.status = 403;
    throw e;
  }
  return Number(id);
}

export function safeReplyText(value, fallback='OK') {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, 1900);
}

export function renderCoreOutput(rendered) {
  if (typeof rendered === 'string') return { text: safeReplyText(rendered) };
  if (!rendered || typeof rendered !== 'object') return { text: 'OK' };
  const text = rendered.text || rendered.message || rendered.caption || rendered.prompt || rendered.title || '';
  const reply = { text: safeReplyText(text || JSON.stringify(rendered).slice(0, 1800)) };
  const buttons = rendered.buttons || rendered.keyboard || rendered.actions;
  if (Array.isArray(buttons)) {
    const flattened = buttons.flat?.(3) || buttons;
    reply.quickReplies = flattened.map((item, i) => {
      if (typeof item === 'string') return { title: item.slice(0, 20), payload: item.slice(0, 1000) };
      const title = String(item?.text || item?.title || item?.label || item?.name || '').trim();
      const payload = String(item?.data || item?.payload || item?.callback_data || item?.value || title || ('ACTION_'+i)).trim();
      return title ? { title: title.slice(0, 20), payload: payload.slice(0, 1000) } : null;
    }).filter(Boolean).slice(0, 13);
  }
  return reply;
}
