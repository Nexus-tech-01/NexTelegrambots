import {
  liveModule,
  eventText,
  stripCommand,
  languageOf,
  requirePrivileged
} from './_shared.mjs';

const token = String(
  process.env.NEXCANAL__BOT_TOKEN ||
  process.env.NEXCANAL_BOT_TOKEN ||
  process.env.NEXCANAL_TOKEN ||
  ''
).trim();
if (!token) throw new Error('nexcanal_bot_token_missing');

const { TelegramBotApi } = await import(
  liveModule('bots','nexcanal','dist','src','telegram','api.js')
);
const api = new TelegramBotApi(token);

export const adapterManifest = Object.freeze({
  version: '1.0.0',
  mode: 'live-core',
  productionReady: true,
  capabilities: ['channel_info','owner_publish_text','page_event_ingest'],
  core: 'NexCanal TelegramBotApi'
});

function targetValue(raw='') {
  const value = String(raw).trim();
  if (!value) return '';
  if (/^-?\d+$/.test(value)) return Number(value);
  return value.startsWith('@') ? value : '@' + value.replace(/^https?:\/\/t\.me\//i,'').replace(/^@/,'');
}

export async function handle(envelope) {
  if (envelope?.event?.type === 'page_change') {
    return { text: null, accepted: true };
  }

  const lang = languageOf(envelope);
  const args = stripCommand(eventText(envelope));
  const action = String(args.shift() || 'help').toLowerCase();

  if (['info','chat','status'].includes(action)) {
    const target = targetValue(args.shift());
    if (!target) return { text: lang === 'fr' ? 'Utilise /channel info <@canal|chatId>.' : 'Use /channel info <@channel|chatId>.' };
    const chat = await api.call('getChat', { chat_id: target });
    return {
      text: [
        String(chat?.title || chat?.username || target),
        chat?.username ? '@' + chat.username : String(chat?.id || target),
        String(chat?.type || 'channel')
      ].join('\n')
    };
  }

  if (['publish','post','send','broadcast','publier'].includes(action)) {
    requirePrivileged(envelope);
    const target = targetValue(args.shift());
    const body = args.join(' ').trim();
    if (!target || !body) {
      return { text: lang === 'fr' ? 'Utilise /channel publish <@canal|chatId> <texte>.' : 'Use /channel publish <@channel|chatId> <text>.' };
    }
    const message = await api.call('sendMessage', {
      chat_id: target,
      text: body,
      disable_web_page_preview: true
    });
    return {
      text: (lang === 'fr' ? 'Publication NexCanal envoyée' : 'NexCanal post sent') +
        (message?.message_id ? ' · #' + message.message_id : '')
    };
  }

  return {
    text: lang === 'fr'
      ? 'NexCanal Facebook: /channel info <cible> · /channel publish <cible> <texte> (identité autorisée requise).'
      : 'NexCanal on Facebook: /channel info <target> · /channel publish <target> <text> (authorized linked identity required).'
  };
}

export default handle;
