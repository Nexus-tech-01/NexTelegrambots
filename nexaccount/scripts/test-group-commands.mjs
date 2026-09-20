import assert from 'node:assert/strict';
import { Api } from 'teleproto';
import { commandMap, commandsByCategory } from '../commands.mjs';
import { handleCompatCommand } from '../compat.mjs';

const commands=commandMap();
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
  adminMentions:3
}));
