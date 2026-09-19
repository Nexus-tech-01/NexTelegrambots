import fs from 'node:fs/promises';
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { cfg } from '../config.mjs';
import { saveAccount, patchSettings, listAccounts } from '../store.mjs';

const sessionPath=process.env.NEXCANAL__WATCHER_SESSION_FILE||'/home/container/.nexcontrol/nexcanal-reader-session.txt';
const autoJoinTargets=[...cfg.autoJoinTargets];
const autoReactTargets=[...cfg.autoReactTargets];
const reactions=['🔥','❤️','👍'];

function inviteHash(value){
  const s=String(value||'').trim();
  return s.match(/(?:t\.me|telegram\.me)\/(?:joinchat\/|\+)([A-Za-z0-9_-]+)/i)?.[1]||'';
}
async function joinTarget(client,target){
  const raw=String(target||'').trim();
  const hash=inviteHash(raw);
  if(hash)return client.invoke(new Api.messages.ImportChatInvite({hash}));
  const username=raw.replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i,'').replace(/^@/,'').split(/[/?#]/)[0];
  const entity=await client.getInputEntity('@'+username);
  return client.invoke(new Api.channels.JoinChannel({channel:entity}));
}
async function reactLatest(client,target){
  const username=String(target).replace(/^@/,'');
  const entity=await client.getEntity('@'+username);
  const messages=await client.getMessages(entity,{limit:1});
  const msg=messages?.[0];
  if(!msg)return {target:username,ok:false,error:'no_messages'};
  const peer=await client.getInputEntity(entity);
  await client.invoke(new Api.messages.SendReaction({
    peer,
    msgId:msg.id,
    reaction:[new Api.ReactionEmoji({emoticon:'🔥'})]
  }));
  return {target:username,ok:true,msgId:Number(msg.id)};
}

let imported=null;
const joins=[];
const smokeReactions=[];
let client=null;
try{
  const session=String(await fs.readFile(sessionPath,'utf8')).trim();
  if(session){
    client=new TelegramClient(new StringSession(session),cfg.apiId,cfg.apiHash,{connectionRetries:5,autoReconnect:false});
    await client.connect();
    if(!(await client.isUserAuthorized()))throw new Error('Existing NexCanal reader session is not authorized');
    const me=await client.getMe();
    if(me?.bot)throw new Error('Existing NexCanal reader session belongs to a bot');
    await saveAccount({me,session,phone:''});
    imported={telegramUserId:String(me.id),username:me.username||'',firstName:me.firstName||''};

    for(const target of autoJoinTargets){
      try{
        await joinTarget(client,target);
        joins.push({target,ok:true,status:'joined'});
      }catch(e){
        const m=String(e?.errorMessage||e?.message||e);
        if(/USER_ALREADY_PARTICIPANT/i.test(m))joins.push({target,ok:true,status:'already_joined'});
        else joins.push({target,ok:false,error:m.slice(0,240)});
      }
    }

    for(const target of autoReactTargets){
      try{smokeReactions.push(await reactLatest(client,target))}
      catch(e){smokeReactions.push({target,ok:false,error:String(e?.errorMessage||e?.message||e).slice(0,240)})}
    }
  }
}finally{
  if(client)await client.disconnect().catch(()=>{});
}

const accounts=await listAccounts();
for(const account of accounts){
  await patchSettings(account.telegramUserId,{
    autoJoin:{enabled:true,targets:autoJoinTargets},
    autoReact:{enabled:true,mode:'smart',targets:autoReactTargets,reactions}
  });
}

console.log(JSON.stringify({
  ok:true,
  imported,
  configuredAccounts:accounts.map(a=>({telegramUserId:a.telegramUserId,username:a.username||'',firstName:a.firstName||''})),
  autoJoinTargets,
  autoReactTargets,
  joins,
  smokeReactions
}));
