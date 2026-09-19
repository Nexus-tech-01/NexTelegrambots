import path from 'node:path';
import { createRequire } from 'node:module';
import { nexusRoot, eventText, stripCommand, languageOf } from './_shared.mjs';

const require = createRequire(import.meta.url);
const previousBotToken = process.env.BOT_TOKEN;
const stickToken = process.env.NEXSTICK__BOT_TOKEN || process.env.NEXSTICK_BOT_TOKEN || process.env.NEXSTICK_TOKEN || '';
if (stickToken) process.env.BOT_TOKEN = stickToken;
const service = require(path.join(nexusRoot,'bots','nexstick','src','services','stickerService.js'));
if (previousBotToken === undefined) delete process.env.BOT_TOKEN;
else process.env.BOT_TOKEN = previousBotToken;

const { telegramJson, stickerFormat } = service;

export const adapterManifest = Object.freeze({
  version: '1.0.0',
  mode: 'live-core',
  productionReady: true,
  capabilities: ['inspect_telegram_sticker_pack','sticker_pack_link','sticker_type_summary'],
  core: 'NexStick src/services/stickerService.js'
});

function packName(raw='') {
  const text = String(raw).trim();
  const m = text.match(/(?:https?:\/\/)?t\.me\/addstickers\/([A-Za-z0-9_]+)/i);
  return (m?.[1] || text).replace(/^@/,'').replace(/[^A-Za-z0-9_]/g,'').slice(0,64);
}

export async function handle(envelope) {
  const lang = languageOf(envelope);
  const args = stripCommand(eventText(envelope));
  const name = packName(args[0] || '');
  if (!name) {
    return {
      text: lang === 'fr'
        ? 'Envoie /sticker suivi du nom ou du lien du pack Telegram.'
        : 'Send /sticker followed by a Telegram pack name or link.'
    };
  }

  const set = await telegramJson('getStickerSet', { name });
  const stickers = Array.isArray(set?.stickers) ? set.stickers : [];
  const counts = { static:0, animated:0, video:0 };
  for (const sticker of stickers) {
    const type = stickerFormat(sticker);
    counts[type] = (counts[type] || 0) + 1;
  }

  const lines = lang === 'fr'
    ? [
        String(set?.title || name),
        stickers.length + ' sticker(s)',
        'Statique: ' + counts.static + ' · Animé: ' + counts.animated + ' · Vidéo: ' + counts.video,
        'https://t.me/addstickers/' + name
      ]
    : [
        String(set?.title || name),
        stickers.length + ' sticker(s)',
        'Static: ' + counts.static + ' · Animated: ' + counts.animated + ' · Video: ' + counts.video,
        'https://t.me/addstickers/' + name
      ];

  return { text: lines.join('\n') };
}

export default handle;
