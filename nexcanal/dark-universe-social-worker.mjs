import fs from 'node:fs/promises';
import {createSocialFeed} from './social-feed.mjs';

const token=String(process.env.NEXCANAL__BOT_TOKEN||'').trim();
const target=String(process.env.NEXSOCIAL__DESTINATION||'tresor_universe').replace(/^@/,'').toLowerCase();
if(!token)throw new Error('nexcanal_bot_token_unavailable');
if(target!=='tresor_universe')throw new Error('dark_universe_destination_not_allowed');
if(process.env.NEXSOCIAL__WHATSAPP_ENABLED!=='false')throw new Error('telegram_only_policy_required');

async function telegram(method,payload={}){
  const response=await fetch('https://api.telegram.org/bot'+token+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.ok!==true)throw new Error('telegram_'+method+': '+String(data.description||response.status).slice(0,180));
  return data.result;
}

const me=await telegram('getMe');
const chat=await telegram('getChat',{chat_id:'@'+target});
const member=await telegram('getChatMember',{chat_id:'@'+target,user_id:me.id});
if(chat.type!=='channel'||member.status!=='administrator'||member.can_post_messages!==true)
  throw new Error('dark_universe_publish_rights_required');

const stateFile=String(process.env.NEXSOCIAL__STATE_FILE||'');
let firstBoot=false;
if(stateFile){
  try{const j=JSON.parse(await fs.readFile(stateFile,'utf8'));firstBoot=!Array.isArray(j?.history)||!j.history.some(x=>x.type==='published');}
  catch(error){if(error?.code==='ENOENT')firstBoot=true;else throw error;}
}
const feed=createSocialFeed({bot:telegram});
await feed.init();
console.log('[DarkUniverseSocial] ready @'+target+' bot=@'+String(me.username||'')+' WhatsApp=disabled');
if(firstBoot&&process.env.NEXSOCIAL__FIRST_POST==='true'){
  console.log('[DarkUniverseSocial] initial publication requested, respecting content verification');
  await feed.tick({force:true});
}
const timer=setInterval(()=>feed.tick().catch(err=>console.warn('[DarkUniverseSocial] tick error',String(err.message).slice(0,180))),60_000);
// Keep the interval referenced so systemd supervises a live publisher.
process.on('SIGINT',()=>process.exit(0));
process.on('SIGTERM',()=>process.exit(0));
await new Promise(()=>{});
