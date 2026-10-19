import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStoryRequest,runStoryCommand,sendGroupStory} from '../story-commands.mjs';

const owner='111111@s.whatsapp.net';
const admin='222222@s.whatsapp.net';
const group='120363401010101010@g.us';
const newsletter='120363411005383995@newsletter';

function scenario({fromMe=true,chat=group,participant=admin,ownerAdmin=true,adminUser=true,extraSocket={}}={}) {
  const calls=[];
  const sock={
    user:{id:owner},
    waUploadToServer:async()=>({}),
    relayMessage:async(jid,body,opts)=>{calls.push({kind:'relay',jid,body,opts})},
    sendMessage:async(jid,content,opts)=>{calls.push({kind:'send',jid,content,opts});return {key:{id:'sent-id'}}},
    groupMetadata:async()=>({participants:[
      {id:owner,admin:ownerAdmin?'admin':null},
      {id:admin,admin:adminUser?'admin':null}
    ]}),
    ...extraSocket
  };
  const message={key:{remoteJid:chat,fromMe,participant}};
  const state={status:'connected',channelJid:newsletter,otakuChannelJid:newsletter,stickGoodChannelJid:newsletter};
  const replies=[];
  const run=(args,readMedia=async()=>null)=>runStoryCommand({
    sock,message,state,args,readMedia,reply:async(_m,text)=>{replies.push(text)}
  });
  return {run,sock,message,state,replies,calls};
}

test('parse story captions and preserve internal vertical bars',()=>{
  assert.deepEqual(parseStoryRequest('channel otaku | Teaser | Partie 2'),{
    mode:'channel',argument:'otaku',caption:'Teaser | Partie 2'
  });
});

test('story destinations are listed without publication',async()=>{
  const t=scenario();
  await t.run('targets');
  assert.match(t.replies[0],/otaku : résolue/);
  assert.equal(t.calls.length,0);
});

test('a non-owner cannot publish to a WhatsApp channel',async()=>{
  const t=scenario({fromMe:false});
  await assert.rejects(t.run('channel nextech | Sneak peek'),/propriétaire/);
  assert.equal(t.calls.length,0);
});

test('channel story refuses normal messages if the connector lacks native status support',async()=>{
  const t=scenario();
  await assert.rejects(t.run('channel otaku | Soon',async()=>({type:'image',buffer:Buffer.from('image')})),/ACK des stories|Transport natif|médias de chaîne/);
  assert.equal(t.calls.length,0);
});

test('native channel adapter uses a real story method when present',async()=>{
  const used=[];
  const t=scenario({extraSocket:{
    newsletterSendStatus:async(jid,content)=>{used.push({jid,content});return {newsletterStatusServerId:123}}
  }});
  await t.run('channel otaku | Nouvelle vidéo',async()=>({type:'image',buffer:Buffer.from('image'),mimetype:'image/jpeg'}));
  assert.equal(used.length,1);
  assert.equal(used[0].jid,newsletter);
  assert.equal(used[0].content.caption,'Nouvelle vidéo');
  assert.equal(t.calls.length,0);
});

test('group story denies a non-admin sender',async()=>{
  const t=scenario({fromMe:false,adminUser:false});
  await assert.rejects(t.run('group | Hello'),/administrateurs/);
  assert.equal(t.calls.length,0);
});

test('group story denies when the connected WhatsApp account is not a group admin',async()=>{
  const t=scenario({ownerAdmin:false});
  await assert.rejects(t.run('group | Hello'),/compte WhatsApp connecté/);
  assert.equal(t.calls.length,0);
});

test('group status submits a groupStatusMessageV2, never an ordinary group message',async()=>{
  const t=scenario();
  await t.run('group | Hello from NexAi');
  assert.equal(t.calls.length,1);
  assert.equal(t.calls[0].kind,'relay');
  assert.equal(t.calls[0].jid,group);
  assert.ok(t.calls[0].body.groupStatusMessageV2);
  assert.match(t.replies[0],/transmise à WhatsApp/);
});

test('personal status never broadcasts without a configured recipient list',async()=>{
  const old=process.env.NEXAI_STORY_AUDIENCE_JIDS;
  delete process.env.NEXAI_STORY_AUDIENCE_JIDS;
  try{
    const t=scenario();
    await assert.rejects(t.run('status | Hello'),/NEXAI_STORY_AUDIENCE_JIDS/);
    assert.equal(t.calls.length,0);
  }finally{
    if(old!==undefined)process.env.NEXAI_STORY_AUDIENCE_JIDS=old;
  }
});

test('story content enforces image/video only',async()=>{
  const t=scenario();
  await assert.rejects(
    t.run('group | Audio',async()=>({type:'audio',buffer:Buffer.from('abc')})),
    /photos et vidéos uniquement/
  );
  assert.equal(t.calls.length,0);
});
