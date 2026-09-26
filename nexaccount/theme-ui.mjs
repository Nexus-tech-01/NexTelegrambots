const clean=v=>String(v??'').trim();

function fill(lines,data){
  const user=clean(data.user)||'Telegram User';
  const rank=clean(data.rank)||'USER';
  const prefix=clean(data.prefix)||'.';
  const count=Number(data.count)||0;
  const bot=(clean(data.botName)||'NEXAI').slice(0,32);
  return lines.map(line=>line
    .replaceAll('{bot}',bot)
    .replaceAll('{user}',user)
    .replaceAll('{rank}',rank.toUpperCase())
    .replaceAll('{prefix}',prefix)
    .replaceAll('{count}',String(count))
  ).join('\n');
}

const T={
  1:{
    header:[
      '♰〔 {bot} • DARK DIPPER 〕',
      '┃ 👤 {user}',
      '┃ ♛ ʀᴀɴɢ • {rank}',
      '┃ ⌁ ᴘʀᴇғɪx • [ {prefix} ]',
      '┃ 🕯 ᴄᴏᴍᴍᴀɴᴅѕ • {count}',
      '╰♰ ᴛʜᴇ ᴅᴀʀᴋɴᴇѕѕ ɪѕ ᴡᴀᴛᴄʜɪɴɢ'
    ],cat:l=>`♰〔 ${l} 〕`,bullet:'┃ ➻ ',footer:'╰♰ DARK SYSTEM'
  },
  2:{
    header:[
      '🍃〔 {bot} • 木ノ葉 / NARUTO 〕',
      '┃ 忍 {user}',
      '┃ 火 ʀᴀɴɢ • {rank}',
      '┃ 印 ᴘʀᴇғɪx • [ {prefix} ]',
      '┃ 巻 ᴊᴜᴛѕᴜ • {count}',
      '╰🍥 火の意志 • WILL OF FIRE'
    ],cat:l=>`🍃〔 ${l} 〕`,bullet:'┃ 影 ',footer:'╰ 木ノ葉'
  },
  3:{
    header:[
      '◈〔 {bot} • SHADOW GARDEN 〕',
      '┃ 影 {user}',
      '┃ ◇ AUTHORITY • {rank}',
      '┃ ◇ TRIGGER • [ {prefix} ]',
      '┃ ◇ MISSIONS • {count}',
      '╰◈ ᴡᴇ ʟᴜʀᴋ ɪɴ ᴛʜᴇ ѕʜᴀᴅᴏᴡѕ'
    ],cat:l=>`◈〔 ${l} // SHADOW ARCHIVE 〕`,bullet:'┃ ◇ ',footer:'╰「 I AM ATOMIC 」'
  },
  4:{
    header:[
      '┌─[ {bot}://ROOT ]',
      '├ user   {user}',
      '├ access {rank}',
      '├ prefix {prefix}',
      '├ modules {count}',
      '└ status ACCESS_GRANTED'
    ],cat:l=>`┌─[ ${l}://MODULE ]`,bullet:'├─ ',footer:'└─ root@nexai:~#'
  },
  5:{
    header:[
      '《 {bot} • PLAYER WINDOW 》',
      '┃ ID • {user}',
      '┃ CLASS • {rank}',
      '┃ KEY • [ {prefix} ]',
      '┃ SKILLS • {count}',
      '╰ QUEST AVAILABLE ◆'
    ],cat:l=>`《 ${l} SKILLS 》`,bullet:'▸ ',footer:'《 QUEST AVAILABLE 》'
  },
  6:{
    header:[
      '✦〔 {bot} • B-KOMACHI / AI 〕',
      '┃ ⭐ {user}',
      '┃ ♡ ѕᴛᴀɢᴇ • {rank}',
      '┃ 🎤 ᴄᴀʟʟ • [ {prefix} ]',
      '┃ ✧ ѕᴏɴɢѕ • {count}',
      '╰★ ʟɪᴇѕ ᴄᴀɴ ʙᴇᴄᴏᴍᴇ ʟᴏᴠᴇ'
    ],cat:l=>`✦〔 ${l} STAGE 〕`,bullet:'♡ ',footer:'✧ NEXT PERFORMANCE • READY'
  },
  7:{
    header:[
      '୨ৎ〔 {bot} • RUBY / IDOL DREAM 〕',
      '┃ 🌸 {user}',
      '┃ ♡ STAR • {rank}',
      '┃ ✦ CALL • [ {prefix} ]',
      '┃ ୨ৎ MOVES • {count}',
      '╰♡ ѕʜɪɴᴇ ᴜɴᴛɪʟ ᴛʜᴇ ѕᴛᴀɢᴇ ɪѕ ʏᴏᴜʀѕ'
    ],cat:l=>`୨ৎ〔 ${l} 〕`,bullet:'♡ ',footer:'୨ৎ SHINE ON'
  },
  8:{
    header:[
      '♾〔 {bot} • SIX EYES / GOJO 〕',
      '┃ 👁 {user}',
      '┃ ∞ STATUS • {rank}',
      '┃ ◉ INPUT • [ {prefix} ]',
      '┃ ♾ TECHNIQUES • {count}',
      '╰∞ ʟɪᴍɪᴛʟᴇѕѕ • INFINITY ACTIVE'
    ],cat:l=>`∞〔 ${l} 〕`,bullet:'│ ◉ ',footer:'╰∞ LIMITLESS'
  },
  9:{
    header:[
      '{bot} / oreki',
      '› {user}',
      '› access : {rank}',
      '› prefix : {prefix}',
      '› cmds   : {count}',
      'energy saving mode.'
    ],cat:l=>String(l).toLowerCase(),bullet:'› ',footer:'done.'
  },
  10:{
    header:[
      '୨୧〔 {bot} • MARIN / COSPLAY 〕',
      '┃ 🎀 {user}',
      '┃ ♡ ROLE • {rank}',
      '┃ ✂ CALL • [ {prefix} ]',
      '┃ 👗 CLOSET • {count}',
      '╰୨୧ ᴡᴇᴀʀ ᴡʜᴀᴛ ʏᴏᴜ ʟᴏᴠᴇ ♡'
    ],cat:l=>`୨୧〔 ${l} 〕`,bullet:'୨୧ ',footer:'♡ READY!'
  },
  11:{
    header:[
      '〔 {bot} • SYSTEM NOTIFICATION 〕',
      '┃ PLAYER • {user}',
      '┃ CLASS • {rank}',
      '┃ COMMAND • [ {prefix} ]',
      '┃ SKILLS • {count}',
      '╰🗡 SHADOW MONARCH • ARISE'
    ],cat:l=>`〔 SKILL TREE • ${l} 〕`,bullet:'▸ ',footer:'〔 ARISE 〕'
  },
  12:{
    header:[
      '👁〔 {bot} • UCHIHA / MADARA 〕',
      '┃ USER • {user}',
      '┃ WAR RANK • {rank}',
      '┃ SEAL • [ {prefix} ]',
      '┃ JUTSU • {count}',
      '╰🌑 ᴡᴀᴋᴇ ᴜᴘ ᴛᴏ ʀᴇᴀʟɪᴛʏ'
    ],cat:l=>`『 👁 ${l} 』`,bullet:'┃ ',footer:'『 INFINITE TSUKUYOMI 』'
  },
  13:{
    header:[
      '〔 {bot} • KYŌKA SUIGETSU 〕',
      '┃ SUBJECT • {user}',
      '┃ CLEARANCE • {rank}',
      '┃ ORDER • [ {prefix} ]',
      '┃ PLANS • {count}',
      '╰🪷 ᴇᴠᴇʀʏᴛʜɪɴɢ ɪѕ ᴀѕ ɪ ᴘʟᴀɴɴᴇᴅ'
    ],cat:l=>`〔 ${l} / EXPERIMENTS 〕`,bullet:'— ',footer:'STATUS • EXPECTED'
  },
  14:{
    header:[
      '♔〔 {bot} • ZERO / GEASS 〕',
      '┃ SUBJECT • {user}',
      '┃ AUTHORITY • {rank}',
      '┃ COMMAND • [ {prefix} ]',
      '┃ ORDERS • {count}',
      '╰👁 ᴀʟʟ ʜᴀɪʟ ʟᴇʟᴏᴜᴄʜ'
    ],cat:l=>`♔〔 ${l} ORDERS 〕`,bullet:'┃ ',footer:'「 OBEY 」'
  },
  15:{
    header:[
      '⚔〔 {bot} • SCOUT REGIMENT 〕',
      '┃ SOLDIER • {user}',
      '┃ RANK • {rank}',
      '┃ SIGNAL • [ {prefix} ]',
      '┃ ORDERS • {count}',
      '╰🪽 FIGHT • ADVANCE • FREEDOM'
    ],cat:l=>`〔 ⚔ ${l} OPERATIONS 〕`,bullet:'▸ ',footer:'KEEP MOVING FORWARD.'
  },
  16:{
    header:[
      '☾〔 {bot} • ANBU / ITACHI 〕',
      '┃ IDENTITY • {user}',
      '┃ CLEARANCE • {rank}',
      '┃ SEAL • [ {prefix} ]',
      '┃ MISSIONS • {count}',
      '╰👁 ѕɪʟᴇɴᴄᴇ ʜɪᴅᴇѕ ᴛʜᴇ ѕᴀᴄʀɪғɪᴄᴇ'
    ],cat:l=>`☾〔 ${l} 〕`,bullet:'・',footer:'MISSION COMPLETE.'
  },
  17:{
    header:[
      '☩〔 {bot} • THE ALMIGHTY 〕',
      '┃ SOUL • {user}',
      '┃ SCHRIFT • {rank}',
      '┃ WORD • [ {prefix} ]',
      '┃ FUTURES • {count}',
      '╰👑 ᴛʜᴇ ғᴜᴛᴜʀᴇ ɪѕ ᴀʟʀᴇᴀᴅʏ ѕᴇᴇɴ'
    ],cat:l=>`☩〔 ${l} POWERS 〕`,bullet:'┃ ',footer:'THE ALMIGHTY SEES ALL.'
  },
  18:{
    header:[
      '〔 {bot} • BUSINESS PRO 〕',
      '│ Account • {user}',
      '│ Access • {rank}',
      '│ Prefix • [ {prefix} ]',
      '│ Commands • {count}',
      '╰ Status • Operational'
    ],cat:l=>String(l),bullet:'• ',footer:'NEXTECH • OPERATIONAL'
  },
  19:{
    header:[
      '🌒〔 {bot} • NIGHT MARKET 〕',
      '┃ BUYER • {user}',
      '┃ ACCESS • {rank}',
      '┃ SEAL • [ {prefix} ]',
      '┃ STOCK • {count}',
      '╰🕯 ᴇᴠᴇʀʏᴛʜɪɴɢ ʜᴀѕ ᴀ ᴘʀɪᴄᴇ'
    ],cat:l=>`🌒〔 ${l} STOCK 〕`,bullet:'│ ◇ ',footer:'╰🕯 MARKET CLOSED'
  },
  20:{
    header:[
      '☄〔 {bot} • PURGE PROTOCOL 〕',
      '┃ TARGET • {user}',
      '┃ AUTHORITY • {rank}',
      '┃ ORDER • [ {prefix} ]',
      '┃ PURGES • {count}',
      '╰🔥 NO MERCY • PROTOCOL ARMED',
      'La purge n’épargne personne.'
    ],cat:l=>`☄〔 ${l} PROTOCOL 〕`,bullet:'┃ ⟢ ',footer:'╰ PURGE COMPLETE'
  },
  21:{
    header:[
      '🌙〔 {bot} • MIO / MIDNIGHT 〕',
      '┃ 🖤 {user}',
      '┃ 𖦹 STATUS • {rank}',
      '┃ ୨୧ CALL • [ {prefix} ]',
      '┃ ✦ DREAMS • {count}',
      '╰𓂃 ᴛʜᴇ ᴍᴏᴏɴ ᴋᴇᴇᴘѕ ᴛʜᴇ ѕᴇᴄʀᴇᴛ'
    ],cat:l=>`୨୧〔 ${l} 〕`,bullet:'│ 𓂃 ',footer:'╰𓂃 QUIET MIDNIGHT'
  },
  22:{
    header:[
      '☾〔 {bot} • CALL OF THE NIGHT 〕',
      '┃ 🦇 {user}',
      '┃ NIGHT ROLE • {rank}',
      '┃ CALL • [ {prefix} ]',
      '┃ BITES • {count}',
      '╰🌃 ѕʟᴇᴇᴘ ɪѕ ʙᴏʀɪɴɢ • ѕᴛᴀʏ ᴜᴘ'
    ],cat:l=>`☾〔 NIGHT ${l} 〕`,bullet:'│ › ',footer:'╰🦇 AFTER DARK'
  },
  23:{
    header:[
      '୨ৎ〔 {bot} • FRAGRANT FLOWER 〕',
      '┃ 🌸 {user}',
      '┃ ROLE • {rank}',
      '┃ PREFIX • [ {prefix} ]',
      '┃ PETALS • {count}',
      '╰❀ ʙʟᴏᴏᴍ ᴡɪᴛʜ ᴋɪɴᴅɴᴇѕѕ'
    ],cat:l=>`୨ৎ〔 ${l} 〕`,bullet:'❀ ',footer:'୨ৎ BLOOM GENTLY'
  },
  24:{
    header:[
      '❄〔 {bot} • ALYA / SECRET WORDS 〕',
      '┃ 🩵 {user}',
      '┃ STATUS • {rank}',
      '┃ PREFIX • [ {prefix} ]',
      '┃ WORDS • {count}',
      '╰❄ Я всё равно не скажу.'
    ],cat:l=>`❄〔 ${l} 〕`,bullet:'◇ ',footer:'COLD OUTSIDE • PRIVATE INSIDE'
  },
  25:{
    header:[
      '🍫〔 {bot} • YAMADA / AFTER SCHOOL 〕',
      '┃ 🎬 {user}',
      '┃ ROLE • {rank}',
      '┃ PREFIX • [ {prefix} ]',
      '┃ SCENES • {count}',
      '╰♡ ѕɴᴀᴄᴋѕ • ѕᴄʜᴏᴏʟ • ǫᴜɪᴇᴛ ᴍᴏᴍᴇɴᴛѕ'
    ],cat:l=>`NOW PLAYING • ${l}`,bullet:'› ',footer:'🍫 END CREDITS'
  },
  26:{
    header:[
      '⚔〔 {bot} • DEFENSE FORCE / HOSHINA 〕',
      '┃ OFFICER • {user}',
      '┃ RANK • {rank}',
      '┃ TRIGGER • [ {prefix} ]',
      '┃ TECHNIQUES • {count}',
      '╰🟣 BLADE COMBAT • READY'
    ],cat:l=>`〔 ⚔ ${l} 〕`,bullet:'╱ ',footer:'VICE-CAPTAIN • READY'
  },
  27:{
    header:[
      '⚽〔 {bot} • BLUE LOCK / BACHIRA 〕',
      '┃ PLAYER • {user}',
      '┃ EGO • {rank}',
      '┃ KICK • [ {prefix} ]',
      '┃ DRIBBLES • {count}',
      '╰⚡ ʟɪѕᴛᴇɴ ᴛᴏ ʏᴏᴜʀ ᴍᴏɴѕᴛᴇʀ'
    ],cat:l=>`⚡〔 ${l} MODE 〕`,bullet:'➤ ',footer:'⚽ FOLLOW YOUR MONSTER'
  },
  28:{
    header:[
      '🎯〔 {bot} • BLUE LOCK / RIN 〕',
      '┃ TARGET • {user}',
      '┃ EGO • {rank}',
      '┃ INPUT • [ {prefix} ]',
      '┃ PLAYS • {count}',
      '╰💚 ANALYZE • DESTROY • SCORE'
    ],cat:l=>`🎯 ${l} / TARGETING`,bullet:'• ',footer:'TARGET LOCKED.'
  },
  29:{
    header:[
      '🩸〔 {bot} • POWER / THE GREAT 〕',
      '┃ HUMAN • {user}',
      '┃ STATUS • {rank}, OBVIOUSLY',
      '┃ ORDER • [ {prefix} ]',
      '┃ POWERS • {count}',
      '╰😈 BOW BEFORE THE BLOOD FIEND!'
    ],cat:l=>`😈〔 ${l}?! 〕`,bullet:'┃ ',footer:'🩸 BOW BEFORE POWER!'
  },
  30:{
    header:[
      '🦋〔 {bot} • BUTTERFLY ESTATE 〕',
      '┃ GUEST • {user}',
      '┃ RANK • {rank}',
      '┃ DOSE • [ {prefix} ]',
      '┃ TECHNIQUES • {count}',
      '╰💜 WISTERIA • POISON READY'
    ],cat:l=>`蝶〔 ${l} 〕`,bullet:'│ ',footer:'🦋 DOSAGE COMPLETE'
  },
  31:{
    header:[
      '⛩〔 {bot} • ASAKUSA / COMPANY 7 〕',
      '┃ FIRE SOLDIER • {user}',
      '┃ RANK • {rank}',
      '┃ SIGNAL • [ {prefix} ]',
      '┃ TECHNIQUES • {count}',
      '╰🔥 MATŌI • ASAKUSA STANDS'
    ],cat:l=>`🔥〔 ${l} 〕`,bullet:'┃ ',footer:'⛩ ASAKUSA STANDS'
  }
};

export function themeUi(styleId){
  return T[Number(styleId)]||T[1];
}

export function renderThemeHeader(styleId,data){
  return fill(themeUi(styleId).header,data);
}

export function renderThemeCategory(styleId,label){
  const t=themeUi(styleId);
  return {
    title:t.cat(clean(label)||'MAIN'),
    bullet:t.bullet||'• ',
    footer:t.footer||''
  };
}

export const THEME_UI_IDS=Object.freeze(Object.keys(T).map(Number));
