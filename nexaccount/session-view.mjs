function cleanId(value){
  const id=String(value??'').trim();
  return /^\d+$/.test(id)?id:'';
}

function displayName(row){
  const username=String(row?.username||'').trim().replace(/^@/,'');
  if(username)return '@'+username;
  const full=[row?.firstName,row?.lastName].map(x=>String(x||'').trim()).filter(Boolean).join(' ');
  return full||cleanId(row?.telegramUserId)||'Compte Telegram';
}

export function connectedSessionRows(rows=[]){
  const byId=new Map();
  for(const row of Array.isArray(rows)?rows:[]){
    const telegramUserId=cleanId(row?.telegramUserId);
    if(!telegramUserId||row?.connected!==true)continue;
    const normalized={
      telegramUserId,
      username:String(row?.username||'').trim().replace(/^@/,''),
      firstName:String(row?.firstName||'').trim(),
      lastName:String(row?.lastName||'').trim(),
      premium:row?.premium===true,
      workerId:String(row?.workerId||'').trim(),
      startedAt:row?.startedAt||null
    };
    const previous=byId.get(telegramUserId);
    if(!previous||(!previous.username&&normalized.username))byId.set(telegramUserId,normalized);
  }
  return [...byId.values()].sort((a,b)=>{
    const an=displayName(a).toLowerCase(),bn=displayName(b).toLowerCase();
    return an.localeCompare(bn)||a.telegramUserId.localeCompare(b.telegramUserId);
  });
}

export function sessionsText(rows,{viewerTelegramUserId='',owner=false,language='fr'}={}){
  const english=String(language||'').toLowerCase().startsWith('en');
  const viewer=cleanId(viewerTelegramUserId);
  const connected=connectedSessionRows(rows);
  const visible=owner===true?connected:connected.filter(row=>row.telegramUserId===viewer);

  if(!visible.length){
    return english
      ? 'NexAi · connected sessions\nNo active Telegram account is currently connected.'
      : 'NexAi · sessions connectées\nAucun compte Telegram actif n’est actuellement connecté.';
  }

  const title=owner===true
    ?(english?'NexAi · connected sessions: ':'NexAi · sessions connectées : ')+visible.length
    :(english?'NexAi · active session':'NexAi · session active');

  const lines=visible.map((row,index)=>{
    const premium=row.premium===true?(english?' · Telegram Premium':' · Telegram Premium'):'';
    return (index+1)+'. '+displayName(row)+
      '\n   ID : '+row.telegramUserId+
      ' · '+(english?'CONNECTED':'CONNECTÉE')+premium;
  });
  return title+'\n\n'+lines.join('\n');
}
