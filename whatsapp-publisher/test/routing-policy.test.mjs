import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const publisher=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const mirror=fs.readFileSync(new URL('../../nexcanal/nextech-whatsapp-mirror.mjs',import.meta.url),'utf8');

function section(source,from,to){
  const start=source.indexOf(from);
  const end=source.indexOf(to,start+from.length);
  assert.ok(start>=0&&end>start,`section not found: ${from}`);
  return source.slice(start,end);
}

const ctx=vm.createContext({
  GROUP_JID:'123@g.us',
  sourceName:(s)=>String(s||'').replace(/^@/,'').toLowerCase(),
  documentBlocked:(m)=>/\.(?:apk|xapk|apks|apkm)$/i.test(m?.fileName||''),
});
vm.runInContext(
  section(publisher,'function isOtakuSource(','async function telegramFileUrl(')+
  section(publisher,'function routePublication(','function addHistory('),
  ctx
);
const route=(pub)=>vm.runInContext('routePublication('+JSON.stringify(pub)+')',ctx);

test('Otaku and Dark Universe go to WhatsApp channels only',()=>{
  for(const source of ['tresor_universe','theotaku_nexus']){
    const r=route({source,media:[]});
    assert.equal(r.group,false);
    assert.equal(r.channel,true);
  }
});

test('NexTech APK files still go to the approved groups, not the newsletter',()=>{
  const r=route({source:'thenexusorigin',media:[{fileName:'example.apk'}]});
  assert.equal(r.group,true);
  assert.equal(r.channel,false);
  assert.equal(r.channelBlocked,true);
  assert.match(publisher,/if\(route\.channelBlocked&&SECONDARY_APK_GROUP_INVITE_URL\) enqueue\('group','__SECONDARY_APK_GROUP__',pub\)/);
});

test('NexTech and NexNews ordinary posts keep group + channel routing',()=>{
  for(const source of ['thenexusorigin','thenexnews']){
    const r=route({source,media:[]});
    assert.equal(r.group,true);
    assert.equal(r.channel,true);
  }
});

test('Otaku historical group backlog is disarmed and no new group relay is enqueued',async()=>{
  const persisted={'otaku-relay-queue.json':[
    {id:'old',status:'pending',groups:[{jid:'123@g.us'}]},
    {id:'done',status:'done'}
  ]};
  const scope=vm.createContext({
    readJson:(key,fallback)=>structuredClone(persisted[key]||fallback),
    writeJson:(key,value)=>{persisted[key]=structuredClone(value)},
    Date,
  });
  vm.runInContext(section(publisher,'async function queueOtakuRelay(','function extractIncomingText('),scope);
  const newResult=await vm.runInContext('queueOtakuRelay({id:"new",kind:"image"})',scope);
  assert.equal(newResult.skipped,true);
  await vm.runInContext('processOtakuRelay()',scope);
  assert.equal(persisted['otaku-relay-queue.json'][0].status,'skipped');
  assert.equal(persisted['otaku-relay-queue.json'][1].status,'done');
  assert.equal(persisted['otaku-relay-queue.json'].length,2);
  assert.equal(publisher.includes('socket.sendMessage(g.jid'),false);
});

test('Queued standard Otaku group jobs are also blocked before WhatsApp delivery',()=>{
  assert.match(publisher,/job\.destination==='group'&&isOtakuSource\(job\.pub\?\.source\)/);
});

test('Generic Telegram mirror excludes Otaku group source even with env override',()=>{
  assert.match(mirror,/x!==['"]theotaku_nexus['"]/);
  assert.match(mirror,/routes:\[\{platform:'whatsapp'\},\{platform:'facebook'\}\]/);
});
