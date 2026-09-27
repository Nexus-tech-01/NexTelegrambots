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
for(const name of ['tagall','mediatag','promote','demote','kick','ban','mute','warnings','slowmode']){
  assert.equal(commands.get(name)?.adminOnly,true,name+' must require admin rights');
}
assert.notEqual(commands.get('hidetag')?.adminOnly,true,'hidetag must be usable by non-admin group members');
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

const tagall=await run('tagall',['Hello']);
assert.equal(tagall.length,3,'tagall must chunk 130 members into three messages');
assert.ok(tagall[0].text.startsWith('Hello'),'tagall must start with the requested introduction');
assert.ok(tagall.flatMap(x=>x.entities).every(e=>e instanceof Api.InputMessageEntityMentionName),'tagall must use outgoing InputMessageEntityMentionName entities');
assert.equal(tagall.reduce((n,x)=>n+x.entities.length,0),130,'tagall must mention every member');
assert.ok(tagall.every(x=>x.text.length<4096),'tagall chunk exceeds Telegram text limit');

const hidden=await run('hidetag',['Secret']);
assert.equal(hidden.length,3,'hidetag must split 130 members into safe hidden-mention batches');
assert.ok(hidden.flatMap(x=>x.entities).every(e=>e instanceof Api.InputMessageEntityMentionName),'hidetag must use outgoing InputMessageEntityMentionName entities');
assert.equal(hidden.reduce((n,x)=>n+x.entities.length,0),130,'hidetag must mention every member');
assert.ok(hidden.every(x=>x.entities.length<=50),'hidetag must keep each hidden mention packet within the safe batch size');
assert.ok(hidden[0].text.startsWith('Secret'),'hidetag must show the requested content only in the first packet');
assert.ok(hidden.slice(1).every(x=>!x.text.includes('Secret')),'hidetag follow-up packets must stay visually hidden');
assert.ok(hidden.every(x=>!x.text.includes('User')),'hidetag must not expose member names');

{
  const sent=[];
  const deleted=[];
  const source={id:42,message:'Message original à republier',entities:[]};
  const client={
    getParticipants:async()=>people,
    getMessages:async()=>[source],
    getInputEntity:async user=>{
      const u=typeof user==='object'&&user?.id?user:people.find(p=>String(p.id)===String(user))||people[0];
      return new Api.InputPeerUser({userId:u.id,accessHash:u.accessHash});
    },
    sendMessage:async(_peer,payload)=>{
      sent.push({text:String(payload.message||''),entities:payload.formattingEntities||[]});
      return payload;
    },
    deleteMessages:async(_peer,ids,options)=>{
      deleted.push({ids:[...ids],options});
      return true;
    }
  };
  const runtime={client,account:{telegramUserId:'999999999'}};
  const event={message:{id:99,peerId:'peer',replyTo:{replyToMsgId:42}}};
  const handled=await handleCompatCommand({
    runtime,event,name:'hidetag',args:[],cmd:{engine:'group'},
    sendText:async(_client,_peer,text)=>sent.push({text:String(text),entities:[]}),
    sendInline:async()=>{}
  });
  assert.equal(handled,true,'reply hidetag must be handled');
  assert.equal(sent.length,3,'reply hidetag must batch hidden mentions when the group exceeds one safe packet');
  assert.ok(sent[0].text.startsWith(source.message),'reply hidetag must resend the replied message once in the first packet');
  assert.ok(sent.slice(1).every(x=>!x.text.includes(source.message)),'reply hidetag follow-up packets must not duplicate the visible replied text');
  assert.equal(sent.reduce((n,x)=>n+x.entities.filter(e=>e instanceof Api.InputMessageEntityMentionName).length,0),130,'reply hidetag must keep all mentions hidden');
  assert.ok(sent.every(x=>x.entities.filter(e=>e instanceof Api.InputMessageEntityMentionName).length<=50),'reply hidetag packets must keep a safe mention count');
  assert.deepEqual(deleted.map(x=>x.ids),[[99]],'reply hidetag must delete the command message');
}
assert.match(compatSource,/name==='hidetag'\?null:1000/,'hidetag must request all retrievable participants instead of stopping at 1000');
assert.match(compatSource,/const HIDDEN_TAG_BATCH=50/,'hidetag must use conservative hidden-mention batches');
assert.match(compatSource,/sendHiddenTaggedCopy\(client,peer,list,source\)/,'hidetag replies must use the replied-message copy path');
assert.match(compatSource,/signature:false/,'hidetag media copies must not append Nextech branding');

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
