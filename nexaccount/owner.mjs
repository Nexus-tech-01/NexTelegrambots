import { analyticsSummary, countryStats, languageStats, userAnalytics, botStats, activityStats, growthStats, commandStats } from './analytics.mjs';

const n=x=>Number(x||0).toLocaleString('fr-FR');
const date=x=>x?new Date(x).toLocaleDateString('fr-FR'):'—';
const en=l=>String(l||'fr').toLowerCase().startsWith('en');

export async function ownerPanelText(language='fr'){
  const s=await analyticsSummary();
  const E=en(language);
  return [
    '╭╼━• 👑 ᴏᴡɴᴇʀ •━━━━',
    '┃ 🔮 '+(E?'ѕʏѕᴛᴇᴍ':'ѕʏѕᴛèᴍᴇ')+' : 🟢',
    '┃ 👥 ᴜѕᴇʀѕ : '+n(s.users),
    '┃ 🟢 '+(E?'ᴀᴄᴛɪᴠᴇ 24ʜ':'ᴀᴄᴛɪғѕ 24ʜ')+' : '+n(s.active24),
    '┃ 🆕 '+(E?'ɴᴇᴡ 24ʜ':'ɴᴏᴜᴠᴇᴀᴜx 24ʜ')+' : '+n(s.new24),
    '┃ ⭐ ᴛᴇʟᴇɢʀᴀᴍ ᴘʀᴇᴍɪᴜᴍ : '+n(s.tgPremium),
    '┃ 🔗 '+(E?'ᴘᴀɪʀᴇᴅ ᴀᴄᴄᴏᴜɴᴛѕ':'ᴄᴏᴍᴘᴛᴇѕ ᴘᴀɪʀéѕ')+' : '+n(s.paired),
    '┃ 🌍 '+(E?'ᴅᴇᴛᴇᴄᴛᴇᴅ ᴄᴏᴜɴᴛʀɪᴇѕ':'ᴘᴀʏѕ ᴅéᴛᴇᴄᴛéѕ')+' : '+n(s.countries),
    '╰━━━━━━━━━━━━━━','','♰ ᴀɴᴀʟʏᴛɪᴄѕ','',
    '/users','/botstats','/activity','/growth','/commandstats','/countries','/languages','/user',
    '','♛ ɴᴇxᴀɪ × ɴᴇxᴛᴇᴄʜ ♛'
  ].join('\n');
}

export async function countriesText(language='fr'){
  const s=await countryStats(20);
  const E=en(language),total=Math.max(1,s.known);
  const lines=[
    '╭╼━• 🌍 '+(E?'ᴄᴏᴜɴᴛʀɪᴇѕ':'ᴘᴀʏѕ')+' •━━━━',
    '┃ 👥 '+(E?'ɪᴅᴇɴᴛɪғɪᴇᴅ':'ɪᴅᴇɴᴛɪғɪéѕ')+' : '+n(s.known),
    '┃ ❔ '+(E?'ᴜɴᴋɴᴏᴡɴ':'ɪɴᴄᴏɴɴᴜѕ')+' : '+n(s.unknown),
    '╰━━━━━━━━━━━━━━',''
  ];
  for(const r of s.rows)lines.push('┃ '+r.country+' : '+n(r.count)+' • '+((r.count/total)*100).toFixed(1)+'%');
  if(!s.rows.length)lines.push(E?'┃ ɴᴏ ᴄᴏᴜɴᴛʀʏ ʀᴇʟɪᴀʙʟʏ ᴅᴇᴛᴇᴄᴛᴇᴅ.':'┃ ᴀᴜᴄᴜɴ ᴘᴀʏѕ ғɪᴀʙʟᴇᴍᴇɴᴛ ᴅéᴛᴇᴄᴛé.');
  return lines.join('\n');
}

export async function languagesText(language='fr'){
  const rows=await languageStats();
  const total=Math.max(1,rows.reduce((a,b)=>a+b.count,0));
  const lines=['╭╼━• 🗣 '+(en(language)?'ʟᴀɴɢᴜᴀɢᴇѕ':'ʟᴀɴɢᴜᴇѕ')+' •━━━━'];
  for(const r of rows){
    const label=r._id==='fr'?'🇫🇷 ғʀᴀɴçᴀɪѕ':r._id==='en'?'🇬🇧 ᴇɴɢʟɪѕʜ':String(r._id||'ᴜɴᴋɴᴏᴡɴ');
    lines.push('┃ '+label+' : '+n(r.count)+' • '+((r.count/total)*100).toFixed(1)+'%');
  }
  lines.push('╰━━━━━━━━━━━━━━');
  return lines.join('\n');
}

export async function botStatsText(language='fr'){
  const s=await botStats(),E=en(language);
  return [
    '╭╼━• 🤖 ʙᴏᴛѕ •━━━━',
    '┃ 👥 '+(E?'ᴜɴɪǫᴜᴇ ᴜѕᴇʀѕ':'ᴜѕᴇʀѕ ᴜɴɪǫᴜᴇѕ')+' : '+n(s.total),
    '╰━━━━━━━━━━━━━━','',
    '┃ 📥 ɴᴇxᴅᴏᴡɴʟᴏᴀᴅᴇʀ : '+n(s.bySource.nexdownloader),
    '┃ 🛡 ɴᴇxɢʀᴏᴜᴘ : '+n(s.bySource.nexgroup),
    '┃ 🎮 ɴᴇxɢᴀᴍᴇ : '+n(s.bySource.nexgame),
    '┃ 🎴 ɴᴇxѕᴛɪᴄᴋ : '+n(s.bySource.nexstick),
    '┃ 🕯 ɴᴇxᴡʜɪѕᴘᴇʀ : '+n(s.bySource.nexwhisper),
    '',
    '┃ 🔗 2+ ʙᴏᴛѕ : '+n(s.multi.twoPlus),
    '┃ 🔗 3+ ʙᴏᴛѕ : '+n(s.multi.threePlus),
    '┃ 🔗 '+(E?'ᴀʟʟ 5':'ʟᴇѕ 5')+' : '+n(s.multi.allFive)
  ].join('\n');
}

export async function activityText(language='fr'){
  const s=await activityStats(),E=en(language);
  return [
    '╭╼━• ⚡ '+(E?'ᴀᴄᴛɪᴠɪᴛʏ':'ᴀᴄᴛɪᴠɪᴛé')+' •━━━━',
    '┃ 🟢 24ʜ : '+n(s.day),
    '┃ 🗓 7ᴅ : '+n(s.week),
    '┃ 📅 30ᴅ : '+n(s.month),
    '┃ 👥 ᴛᴏᴛᴀʟ : '+n(s.total),
    '╰━━━━━━━━━━━━━━'
  ].join('\n');
}

export async function growthText(language='fr'){
  const rows=await growthStats(14),E=en(language);
  const lines=['╭╼━• 📈 '+(E?'ɢʀᴏᴡᴛʜ':'ᴄʀᴏɪѕѕᴀɴᴄᴇ')+' •━━━━','┃ '+(E?'ʟᴀѕᴛ 14 ᴅᴀʏѕ':'14 ᴅᴇʀɴɪᴇʀѕ ᴊᴏᴜʀѕ'),'╰━━━━━━━━━━━━━━',''];
  for(const r of rows)lines.push('┃ '+r.date.slice(5)+' : +'+n(r.count));
  return lines.join('\n');
}

export async function commandStatsText(language='fr'){
  const rows=await commandStats(),E=en(language);
  const lines=['╭╼━• 📜 '+(E?'ᴄᴏᴍᴍᴀɴᴅѕ':'ᴄᴏᴍᴍᴀɴᴅᴇѕ')+' •━━━━','┃ ᴛᴏᴘ 20 • 5 ʙᴏᴛѕ','╰━━━━━━━━━━━━━━',''];
  let i=1;
  for(const r of rows)lines.push('┃ '+String(i++).padStart(2,'0')+' • /'+String(r.command).replace(/^\//,'')+' : '+n(r.count));
  if(!rows.length)lines.push(E?'┃ ɴᴏ ᴅᴀᴛᴀ.':'┃ ᴀᴜᴄᴜɴᴇ ᴅᴏɴɴéᴇ.');
  return lines.join('\n');
}

export async function userText(query,language='fr'){
  const E=en(language);
  if(!String(query||'').trim())return E?'ᴜѕᴀɢᴇ : /user <ɪᴅ|@ᴜѕᴇʀɴᴀᴍᴇ>':'ᴜѕᴀɢᴇ : /user <ɪᴅ|@ᴜѕᴇʀɴᴀᴍᴇ>';
  const u=await userAnalytics(query);
  if(!u)return E?'ᴜѕᴇʀ ɴᴏᴛ ғᴏᴜɴᴅ.':'ᴜѕᴇʀ ɪɴᴛʀᴏᴜᴠᴀʙʟᴇ.';
  return [
    '╭╼━• 👤 ᴜѕᴇʀ •━━━━',
    '┃ 🆔 ɪᴅ : '+u.telegramUserId,
    '┃ 👤 '+(E?'ɴᴀᴍᴇ':'ɴᴏᴍ')+' : '+([u.firstName,u.lastName].filter(Boolean).join(' ')||'—'),
    '┃ 🔗 ᴜѕᴇʀɴᴀᴍᴇ : '+(u.username?'@'+u.username:'—'),
    '┃ 🌍 '+(E?'ᴄᴏᴜɴᴛʀʏ':'ᴘᴀʏѕ')+' : '+(u.countryIso||(E?'ᴜɴᴋɴᴏᴡɴ':'ɪɴᴄᴏɴɴᴜ')),
    '┃ 🗣 '+(E?'ʟᴀɴɢᴜᴀɢᴇ':'ʟᴀɴɢᴜᴇ')+' : '+(u.language||(E?'ᴜɴᴋɴᴏᴡɴ':'ɪɴᴄᴏɴɴᴜ')),
    '┃ ⭐ ᴛɢ ᴘʀᴇᴍɪᴜᴍ : '+(u.telegramPremium?'ʏᴇѕ':'ɴᴏ'),
    '┃ 🔗 ᴘᴀɪʀᴇᴅ : '+(u.paired?'ʏᴇѕ':'ɴᴏ'),
    '┃ 📅 ғɪʀѕᴛ ѕᴇᴇɴ : '+date(u.firstSeen),
    '┃ 🕒 ʟᴀѕᴛ ѕᴇᴇɴ : '+date(u.lastSeen),
    '┃ ⚡ '+(E?'ᴄᴏᴍᴍᴀɴᴅѕ':'ᴄᴏᴍᴍᴀɴᴅᴇѕ')+' : '+n(u.totalCommandCount),
    '┃ 🧩 ʙᴏᴛѕ : '+(u.sources?.filter(s=>s.startsWith('nex')&&s!=='nexaccount'&&s!=='nexai').join(' • ')||'—'),
    '╰━━━━━━━━━━━━━━'
  ].join('\n');
}
