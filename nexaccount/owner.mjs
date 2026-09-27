import { analyticsSummary, countryStats, languageStats, usersList, userAnalytics, botStats, activityStats, growthStats, commandStats } from './analytics.mjs';

const n=x=>Number(x||0).toLocaleString('fr-FR');
const date=x=>x?new Date(x).toLocaleString('fr-FR'):'—';
const en=l=>String(l||'fr').toLowerCase().startsWith('en');

export async function ownerPanelText(language='fr'){
  const s=await analyticsSummary();
  const E=en(language);
  return [
    '╭╼━• 👑 ᴏᴡɴᴇʀ •━━━━',
    '┃ 🔮 '+(E?'ѕʏѕᴛᴇᴍ':'ѕʏѕᴛèᴍᴇ')+' : 🟢',
    '┃ 👥 '+(E?'ᴍᴜʟᴛɪѕᴇѕѕɪᴏɴ ᴜѕᴇʀѕ':'ᴜᴛɪʟɪѕᴀᴛᴇᴜʀѕ ᴍᴜʟᴛɪѕᴇѕѕɪᴏɴ')+' : '+n(s.users),
    '┃ 🟢 '+(E?'ʟɪᴠᴇ ʀᴜɴᴛɪᴍᴇѕ':'ѕᴇѕѕɪᴏɴѕ ᴇɴ ʟɪɢɴᴇ')+' : '+n(s.live),
    '┃ ⚡ '+(E?'ᴀᴄᴛɪᴠᴇ 24ʜ':'ᴀᴄᴛɪғѕ 24ʜ')+' : '+n(s.active24),
    '┃ 🆕 '+(E?'ɴᴇᴡ 24ʜ':'ɴᴏᴜᴠᴇᴀᴜx 24ʜ')+' : '+n(s.new24),
    '┃ ⭐ ᴛᴇʟᴇɢʀᴀᴍ ᴘʀᴇᴍɪᴜᴍ : '+n(s.tgPremium),
    '┃ 🌍 '+(E?'ᴅᴇᴛᴇᴄᴛᴇᴅ ᴄᴏᴜɴᴛʀɪᴇѕ':'ᴘᴀʏѕ ᴅéᴛᴇᴄᴛéѕ')+' : '+n(s.countries),
    '╰━━━━━━━━━━━━━━','','♰ '+(E?'ʀᴇᴀʟ ᴍᴜʟᴛɪѕᴇѕѕɪᴏɴ ᴅᴀᴛᴀ':'ᴅᴏɴɴéᴇѕ ʀéᴇʟʟᴇѕ ᴍᴜʟᴛɪѕᴇѕѕɪᴏɴ'),'',
    '/users','/botstats','/activity','/growth','/commandstats','/countries','/languages','/user',
    '','♛ ɴᴇxᴀɪ × ɴᴇxᴛᴇᴄʜ ♛'
  ].join('\n');
}

export async function usersText(language='fr'){
  const E=en(language);
  const rows=await usersList(40);
  const summary=await analyticsSummary();
  const lines=[
    '╭╼━• 👥 '+(E?'ᴍᴜʟᴛɪѕᴇѕѕɪᴏɴ ᴜѕᴇʀѕ':'ᴜᴛɪʟɪѕᴀᴛᴇᴜʀѕ ᴍᴜʟᴛɪѕᴇѕѕɪᴏɴ')+' •━━━━',
    '┃ '+(E?'ᴛᴏᴛᴀʟ':'ᴛᴏᴛᴀʟ')+' : '+n(summary.users),
    '┃ '+(E?'ʟɪᴠᴇ':'ᴇɴ ʟɪɢɴᴇ')+' : '+n(summary.live),
    '╰━━━━━━━━━━━━━━',''
  ];
  for(const row of rows){
    const name=row.username?'@'+row.username:([row.firstName,row.lastName].filter(Boolean).join(' ')||'—');
    const status=row.live?'🟢':row.sessionRepairRequired?'🛠':'⚪';
    const repair=row.sessionRepairRequired
      ?(E?' · session reconnect required':' · session à reconnecter')
      :'';
    lines.push(
      '┃ '+status+' '+name+
      ' · '+row.telegramUserId+
      (row.premium?' · ⭐':'')+
      repair
    );
  }
  if(!rows.length)lines.push(E?'┃ ɴᴏ ᴄᴏɴɴᴇᴄᴛᴇᴅ ᴀᴄᴄᴏᴜɴᴛ.':'┃ ᴀᴜᴄᴜɴ ᴄᴏᴍᴘᴛᴇ ᴄᴏɴɴᴇᴄᴛé.');
  if(summary.users>rows.length)lines.push('',E?'┃ ѕʜᴏᴡɪɴɢ ғɪʀѕᴛ 40.':'┃ ᴀғғɪᴄʜᴀɢᴇ ᴅᴇѕ 40 ᴘʀᴇᴍɪᴇʀѕ.');
  return lines.join('\n');
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
    '╭╼━• 🤖 '+(E?'ᴍᴜʟᴛɪѕᴇѕѕɪᴏɴ ѕᴛᴀᴛѕ':'ѕᴛᴀᴛѕ ᴍᴜʟᴛɪѕᴇѕѕɪᴏɴ')+' •━━━━',
    '┃ 👥 '+(E?'ѕᴀᴠᴇᴅ ѕᴇѕѕɪᴏɴѕ':'ѕᴇѕѕɪᴏɴѕ ᴇɴʀᴇɢɪѕᴛʀéᴇѕ')+' : '+n(s.total),
    '┃ 🟢 '+(E?'ʟɪᴠᴇ ʀᴜɴᴛɪᴍᴇѕ':'ѕᴇѕѕɪᴏɴѕ ᴇɴ ʟɪɢɴᴇ')+' : '+n(s.live),
    '┃ ⚪ '+(E?'ɴᴏᴛ ʟɪᴠᴇ':'ʜᴏʀѕ ʟɪɢɴᴇ')+' : '+n(s.offline),
    '┃ 🛠 '+(E?'ѕᴇѕѕɪᴏɴѕ ᴛᴏ ʀᴇᴄᴏɴɴᴇᴄᴛ':'ѕᴇѕѕɪᴏɴѕ à ʀᴇᴄᴏɴɴᴇᴄᴛᴇʀ')+' : '+n(s.repairRequired),
    '┃ ⭐ ᴘʀᴇᴍɪᴜᴍ : '+n(s.premium),
    '┃ 🌐 '+(E?'ᴘᴜʙʟɪᴄ ᴍᴏᴅᴇ':'ᴍᴏᴅᴇ ᴘᴜʙʟɪᴄ')+' : '+n(s.publicMode),
    '┃ 🔒 '+(E?'ᴘʀɪᴠᴀᴛᴇ ᴍᴏᴅᴇ':'ᴍᴏᴅᴇ ᴘʀɪᴠé')+' : '+n(s.privateMode),
    '┃ 🧩 '+(E?'ᴀᴄᴛɪᴠᴇ ᴡᴏʀᴋᴇʀѕ':'ᴡᴏʀᴋᴇʀѕ ᴀᴄᴛɪғѕ')+' : '+n(s.workers),
    '╰━━━━━━━━━━━━━━'
  ].join('\n');
}

export async function activityText(language='fr'){
  const s=await activityStats(),E=en(language);
  return [
    '╭╼━• ⚡ '+(E?'ᴀᴄᴛɪᴠɪᴛʏ':'ᴀᴄᴛɪᴠɪᴛé')+' •━━━━',
    '┃ 🟢 '+(E?'ʟɪᴠᴇ ɴᴏᴡ':'ᴇɴ ʟɪɢɴᴇ')+' : '+n(s.live),
    '┃ 🕒 24ʜ : '+n(s.day),
    '┃ 🗓 7ᴅ : '+n(s.week),
    '┃ 📅 30ᴅ : '+n(s.month),
    '┃ 👥 ᴛᴏᴛᴀʟ : '+n(s.total),
    '╰━━━━━━━━━━━━━━'
  ].join('\n');
}

export async function growthText(language='fr'){
  const rows=await growthStats(14),E=en(language);
  const lines=['╭╼━• 📈 '+(E?'ɢʀᴏᴡᴛʜ':'ᴄʀᴏɪѕѕᴀɴᴄᴇ')+' •━━━━','┃ '+(E?'ɴᴇᴡ ᴍᴜʟᴛɪѕᴇѕѕɪᴏɴ ᴀᴄᴄᴏᴜɴᴛѕ · 14 ᴅᴀʏѕ':'ɴᴏᴜᴠᴇᴀᴜx ᴄᴏᴍᴘᴛᴇѕ ᴍᴜʟᴛɪѕᴇѕѕɪᴏɴ · 14 ᴊᴏᴜʀѕ'),'╰━━━━━━━━━━━━━━',''];
  for(const r of rows)lines.push('┃ '+r.date.slice(5)+' : +'+n(r.count));
  return lines.join('\n');
}

export async function commandStatsText(language='fr'){
  const rows=await commandStats(),E=en(language);
  const lines=['╭╼━• 📜 '+(E?'ᴄᴏᴍᴍᴀɴᴅѕ':'ᴄᴏᴍᴍᴀɴᴅᴇѕ')+' •━━━━','┃ '+(E?'ᴛᴏᴘ 20 · ᴍᴜʟᴛɪѕᴇѕѕɪᴏɴ ᴏɴʟʏ':'ᴛᴏᴘ 20 · ᴍᴜʟᴛɪѕᴇѕѕɪᴏɴ ѕᴇᴜʟᴇᴍᴇɴᴛ'),'╰━━━━━━━━━━━━━━',''];
  let i=1;
  for(const r of rows)lines.push('┃ '+String(i++).padStart(2,'0')+' • /'+String(r.command).replace(/^\//,'')+' : '+n(r.count));
  if(!rows.length)lines.push(E?'┃ ɴᴏ ᴅᴀᴛᴀ.':'┃ ᴀᴜᴄᴜɴᴇ ᴅᴏɴɴéᴇ.');
  return lines.join('\n');
}

export async function userText(query,language='fr'){
  const E=en(language);
  if(!String(query||'').trim())return E?'ᴜѕᴀɢᴇ : /user <ɪᴅ|@ᴜѕᴇʀɴᴀᴍᴇ>':'ᴜѕᴀɢᴇ : /user <ɪᴅ|@ᴜѕᴇʀɴᴀᴍᴇ>';
  const u=await userAnalytics(query);
  if(!u)return E?'ᴍᴜʟᴛɪѕᴇѕѕɪᴏɴ ᴜѕᴇʀ ɴᴏᴛ ғᴏᴜɴᴅ.':'ᴜᴛɪʟɪѕᴀᴛᴇᴜʀ ᴍᴜʟᴛɪѕᴇѕѕɪᴏɴ ɪɴᴛʀᴏᴜᴠᴀʙʟᴇ.';
  return [
    '╭╼━• 👤 ᴜѕᴇʀ •━━━━',
    '┃ 🆔 ɪᴅ : '+u.telegramUserId,
    '┃ 👤 '+(E?'ɴᴀᴍᴇ':'ɴᴏᴍ')+' : '+([u.firstName,u.lastName].filter(Boolean).join(' ')||'—'),
    '┃ 🔗 ᴜѕᴇʀɴᴀᴍᴇ : '+(u.username?'@'+u.username:'—'),
    '┃ '+(u.live?'🟢':u.sessionRepairRequired?'🛠':'⚪')+' '+(E?'ѕᴇѕѕɪᴏɴ':'ѕᴇѕѕɪᴏɴ')+' : '+(
      u.live
        ?(E?'ʟɪᴠᴇ':'ᴇɴ ʟɪɢɴᴇ')
        :u.sessionRepairRequired
          ?(E?'ʀᴇᴄᴏɴɴᴇᴄᴛ ʀᴇǫᴜɪʀᴇᴅ':'ʀᴇᴄᴏɴɴᴇxɪᴏɴ ʀᴇǫᴜɪѕᴇ')
          :(E?'ѕᴀᴠᴇᴅ · ɴᴏᴛ ʟɪᴠᴇ':'ᴇɴʀᴇɢɪѕᴛʀéᴇ · ʜᴏʀѕ ʟɪɢɴᴇ')
    ),
    '┃ 🌍 '+(E?'ᴄᴏᴜɴᴛʀʏ':'ᴘᴀʏѕ')+' : '+(u.countryIso||(E?'ᴜɴᴋɴᴏᴡɴ':'ɪɴᴄᴏɴɴᴜ')),
    '┃ 🗣 '+(E?'ʟᴀɴɢᴜᴀɢᴇ':'ʟᴀɴɢᴜᴇ')+' : '+(u.language||(E?'ᴜɴᴋɴᴏᴡɴ':'ɪɴᴄᴏɴɴᴜ')),
    '┃ ⭐ ᴛɢ ᴘʀᴇᴍɪᴜᴍ : '+(u.telegramPremium?'ʏᴇѕ':'ɴᴏ'),
    '┃ 🔐 '+(E?'ᴀᴄᴄᴇѕѕ ᴍᴏᴅᴇ':'ᴍᴏᴅᴇ ᴅ’ᴀᴄᴄèѕ')+' : '+u.accessMode,
    '┃ ⌨️ ᴘʀᴇғɪx : '+u.prefix,
    '┃ 📅 '+(E?'ғɪʀѕᴛ ᴘᴀɪʀᴇᴅ':'ᴘʀᴇᴍɪèʀᴇ ᴄᴏɴɴᴇxɪᴏɴ')+' : '+date(u.firstSeen),
    '┃ 🕒 '+(E?'ʟᴀѕᴛ ᴀᴄᴛɪᴠɪᴛʏ':'ᴅᴇʀɴɪèʀᴇ ᴀᴄᴛɪᴠɪᴛé')+' : '+date(u.lastSeen),
    '┃ ⚡ '+(E?'ᴄᴏᴍᴍᴀɴᴅѕ':'ᴄᴏᴍᴍᴀɴᴅᴇѕ')+' : '+n(u.totalCommandCount),
    '╰━━━━━━━━━━━━━━'
  ].join('\n');
}
