import fs from 'node:fs';
import path from 'node:path';

const root = '/opt/nex/apps/public/stacy/current';
const file = path.join(root, 'src/bot.js');
const marker = 'NEXGROUP_READD_AUTO_PROMOTE_V1';

let source = fs.readFileSync(file, 'utf8');

if (!source.includes(marker)) {
  const requireLine = "const ensureNexGroupAdmin = require('./ops/ensureNexGroupAdmin'); // " + marker;
  const useStrict = "'use strict';";
  if (source.includes(useStrict)) {
    source = source.replace(useStrict, useStrict + "\n" + requireLine);
  } else {
    source = requireLine + "\n" + source;
  }

  const anchor = "bot.on('new_chat_members', welcomeHandler);";
  if (!source.includes(anchor)) throw new Error('welcome new_chat_members anchor not found');

  const listener = `
  bot.on('new_chat_members', async (ctx, next) => {
    const targetChatId = -1004429463289;
    const targetBotId = 8646461935;
    const members = Array.isArray(ctx.message?.new_chat_members) ? ctx.message.new_chat_members : [];

    if (Number(ctx.chat?.id) === targetChatId && members.some((m) => Number(m?.id) === targetBotId)) {
      try {
        await ensureNexGroupAdmin(bot);
      } catch (error) {
        console.error('[nexgroup-auto-promote]', error);
      }
    }

    return next();
  }); // ${marker}

  `;

  source = source.replace(anchor, listener + anchor);
  const backup = file + '.pre-readd-auto-' + new Date().toISOString().replace(/[:.]/g, '-') + '.bak';
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, source, 'utf8');
  console.log(JSON.stringify({ ok: true, changed: true, backup }));
} else {
  console.log(JSON.stringify({ ok: true, changed: false, reason: 'already-installed' }));
}
