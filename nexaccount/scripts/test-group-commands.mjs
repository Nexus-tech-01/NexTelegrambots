import assert from 'node:assert/strict';
import { Api } from 'teleproto';
import { commandMap, commandsByCategory } from '../commands.mjs';
import { handleCompatCommand } from '../compat.mjs';

const commands=commandMap();
const compatSource=await import('node:fs').then(fs=>fs.readFileSync(new URL('../compat.mjs',import.meta.url),'utf8'));
const grouped=commandsByCategory(commands);

assert.equal(grouped.ADMIN,undefined,'ADMIN must not be a separate visible category');
assert.ok((grouped.GROUP||[]).length>=40,'GROUP category unexpectedly small');

for(const name of ['tag','tagall','hidetag','mediatag','tagadmin','promote','demote','kick','ban','mute','warnings','slowmode']){
  const cmd=commands.get(name);
  assert.ok(cmd,'missing '+name);
  assert.equal(cmd.category,'GROUP',name+' must be in GROUP');
  assert.equal(cmd.groupOnly,true,name+' must be group-only');
  assert.equal(cmd.engine,'group',name+' must use the group engine');
}
for(const name of ['tagall','hidetag','mediatag','promote','demote','kick','ban','mute','warnings','slowmode']){
  assert.equal(commands.get(name)?.adminOnly,true,name+' must require admin rights');
}
assert.match(compatSource,/getInputChannel/,'channel APIs must import InputChannel conversion');
assert.match(compatSource,/const channel=getInputChannel\(await client\.getInputEntity\(peer\)\)/,'moderation APIs must receive InputChannel');
assert.match(compatSource,/ToggleSlowMode\(\{channel:input,seconds\}\)/,'slowmode route must use converted InputChannel');
assert.match(compatSource,/const target=getInputUser\(targetPeer\)/,'moderation APIs must receive InputUser');
assert.match(compatSource,/users:\[user\]/,'group invite route must use converted InputUser');
assert.match(compatSource,/HideChatJoinRequest\(\{peer:input,userId:user,approved:true\}\)/,'join approval must use converted InputUser');

assert.equal(commands.get('mode')?.selfOnly,true,'mode must be owner-only');
for(const name of ['block','unblock','vv','sticker','clonepack','createpack','customreact','emoji_status','effect']){
  assert.equal(commands.get(name)?.selfOnly,true,name+' must stay unavailable to public callers');
}

const people=Array.from({length:130},(_,i)=>({
  id:BigInt(i+1),
  firstName:'User'+(i+1),
  accessHash:BigInt(100000+i),
  participant:i<3?{className:'ChannelParticipantAdmin',adminRights:{}}:{className:'ChannelParticipant'}
}));

async function run(name,args=[]){
  const sent=[];
  const client={
    getParticipants:async()=>people,
    getEntity:async()=>people[0],
    getInputEntity:async user=>{
      const u=typeof user==='object'&&user?.id?user:people.find(p=>String(p.id)===String(user))||people[0];
      return new Api.InputPeerUser({userId:u.id,accessHash:u.accessHash});
    },
    sendMessage:async(_peer,payload)=>{
      sent.push({text:String(payload.message||''),entities:payload.formattingEntities||[]});
      return payload;
    }
  };
  const runtime={client,account:{telegramUserId:'999999999'}};
  const event={message:{peerId:'peer'}};
  const sendText=async(_client,_peer,text)=>sent.push({text:String(text),entities:[]});
  const handled=await handleCompatCommand({
    runtime,event,name,args,cmd:{engine:'group'},sendText,sendInline:async()=>{}
  });
  assert.equal(handled,true,name+' must be handled');
  return sent;
}

async function runAction(name,args=[]){
  const sent=[],invoked=[];
  const channelPeer=new Api.InputPeerChannel({channelId:1001n,accessHash:2002n});
  const userPeer=new Api.InputPeerUser({userId:3003n,accessHash:4004n});
  const client={
    getMessages:async()=>[],
    getInputEntity:async value=>value==='peer'?channelPeer:userPeer,
    invoke:async request=>{invoked.push(request);return {link:'https://t.me/+qa'};},
    sendMessage:async(_peer,payload)=>{sent.push(String(payload.message||''));return payload;}
  };
  const runtime={client,account:{telegramUserId:'999999999'}};
  const event={message:{peerId:'peer',id:1,out:true},isGroup:true};
  const sendText=async(_client,_peer,text)=>sent.push(String(text));
  const handled=await handleCompatCommand({
    runtime,event,name,args,cmd:{engine:'group'},sendText,sendInline:async()=>{}
  });
  assert.equal(handled,true,name+' action must be handled');
  return {sent,invoked};
}

const promoteAction=await runAction('promote',['@target']);
assert.ok(promoteAction.invoked[0] instanceof Api.channels.EditAdmin,'promote must call channels.EditAdmin');
assert.ok(promoteAction.invoked[0].channel instanceof Api.InputChannel,'promote must use InputChannel');
assert.ok(promoteAction.invoked[0].userId instanceof Api.InputUser,'promote must use InputUser');
assert.doesNotThrow(()=>promoteAction.invoked[0].getBytes(),'promote request must serialize');

const banAction=await runAction('ban',['@target']);
assert.ok(banAction.invoked[0] instanceof Api.channels.EditBanned,'ban must call channels.EditBanned');
assert.ok(banAction.invoked[0].channel instanceof Api.InputChannel,'ban must use InputChannel');
assert.doesNotThrow(()=>banAction.invoked[0].getBytes(),'ban request must serialize');

const addAction=await runAction('add',['@target']);
assert.ok(addAction.invoked[0] instanceof Api.channels.InviteToChannel,'add must call channels.InviteToChannel');
assert.ok(addAction.invoked[0].channel instanceof Api.InputChannel,'add must use InputChannel');
assert.ok(addAction.invoked[0].users?.[0] instanceof Api.InputUser,'add must use InputUser');
assert.doesNotThrow(()=>addAction.invoked[0].getBytes(),'add request must serialize');

const approveAction=await runAction('approve',['@target']);
assert.ok(approveAction.invoked[0] instanceof Api.messages.HideChatJoinRequest,'approve must call HideChatJoinRequest');
assert.ok(approveAction.invoked[0].userId instanceof Api.InputUser,'approve must use InputUser');
assert.doesNotThrow(()=>approveAction.invoked[0].getBytes(),'approve request must serialize');

const tagall=await run('tagall',['Hello']);
assert.equal(tagall.length,3,'tagall must chunk 130 members into three messages');
assert.ok(tagall[0].text.startsWith('Hello'),'tagall must start with the requested introduction');
assert.ok(tagall.flatMap(x=>x.entities).every(e=>e instanceof Api.InputMessageEntityMentionName),'tagall must use outgoing InputMessageEntityMentionName entities');
assert.equal(tagall.reduce((n,x)=>n+x.entities.length,0),130,'tagall must mention every member');
assert.ok(tagall.every(x=>x.text.length<4096),'tagall chunk exceeds Telegram text limit');

const hidden=await run('hidetag',['Secret']);
assert.equal(hidden.length,3,'hidetag must chunk 130 members into three messages');
assert.ok(hidden.flatMap(x=>x.entities).every(e=>e instanceof Api.InputMessageEntityMentionName),'hidetag must use outgoing InputMessageEntityMentionName entities');
assert.equal(hidden.reduce((n,x)=>n+x.entities.length,0),130,'hidetag must mention every member');
assert.ok(hidden.every(x=>!x.text.includes('User')),'hidetag must not expose member names');

const admins=await run('tagadmin');
assert.equal(admins.reduce((n,x)=>n+x.entities.length,0),3,'tagadmin must mention admins only');

const single=await run('tag',['@user','Hi']);
assert.equal(single.length,1,'tag must send one message');
assert.equal(single[0].entities.length,1,'tag must contain one mention entity');

console.log(JSON.stringify({
  ok:true,
  groupCommands:(grouped.GROUP||[]).length,
  tagallMessages:tagall.length,
  hidetagMessages:hidden.length,
  outgoingEntity:'InputMessageEntityMentionName',
  tagallMentions:130,
  hidetagMentions:130,
  adminMentions:3,
  mtprotoActions:['promote','ban','add','approve']
}));
