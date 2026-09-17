import crypto from 'node:crypto';

const BASE='https://nexcontrol-ochre.vercel.app';
const SESSION=String(process.env.NXC_SESSION||'').trim();
if(!SESSION) throw new Error('NXC_SESSION missing');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sha=s=>crypto.createHash('sha256').update(Buffer.from(s,'utf8')).digest('hex');

async function request(path,{method='GET',body}={}){
  const r=await fetch(BASE+path,{method,headers:{cookie:`nexcontrol_session=${SESSION}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'manual'});
  const text=await r.text();
  let data; try{data=text?JSON.parse(text):{}}catch{data={raw:text.slice(0,1000)}}
  if(!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${JSON.stringify(data).slice(0,1600)}`);
  return data;
}
async function create(kind,payload){
  const d=await request('/api/admin/agent/jobs',{method:'POST',body:{agentSlug:'nexus-main',kind,payload}});
  if(!d.jobId) throw new Error(`No jobId for ${kind}`);
  return d.jobId;
}
async function waitJob(id,timeoutMs=180000){
  const start=Date.now();
  while(Date.now()-start<timeoutMs){
    const j=await request(`/api/admin/agent/jobs?id=${encodeURIComponent(id)}`);
    if(j.status==='succeeded') return j;
    if(j.status==='failed') throw new Error(`Agent job ${id} failed: ${j.error||'unknown error'}`);
    await sleep(2000);
  }
  throw new Error(`Agent job ${id} timeout`);
}
async function run(kind,payload,timeoutMs){return waitJob(await create(kind,payload),timeoutMs)}
async function read(root,path,expectedSha){
  const j=await run('fs.read',{root,path},60000);
  const actual=j.result?.sha256;
  if(expectedSha&&actual!==expectedSha) throw new Error(`Baseline SHA mismatch ${root}/${path}: expected ${expectedSha}, got ${actual}`);
  return {content:String(j.result?.content||''),sha256:actual};
}
function replaceOnce(s,from,to,label){
  const i=s.indexOf(from); if(i<0) throw new Error(`Patch anchor missing: ${label}`);
  if(s.indexOf(from,i+1)>=0) throw new Error(`Patch anchor not unique: ${label}`);
  return s.slice(0,i)+to+s.slice(i+from.length);
}
async function write(root,path,content,expectedSha,expectedAfter){
  if(sha(content)!==expectedAfter) throw new Error(`Local transformed SHA mismatch ${root}/${path}: got ${sha(content)}, expected ${expectedAfter}`);
  const j=await run('fs.write',{root,path,content,...(expectedSha?{expectedSha}:{})},120000);
  if(j.result?.afterSha!==expectedAfter) throw new Error(`Agent afterSha mismatch ${root}/${path}`);
  console.log(`[write] OK ${root}/${path} backup=${j.result?.backupId||'new'}`);
}

console.log('[hotfix] v61.08.1 live patch start');

// NEXCANAL: keep fitting media text as the media caption even when it contains custom emoji.
{
  const root='nexcanal', path='src/services/publisher.ts', old='925c5a3ddad807b2d5ed0d6900b05a3c8eba5697bfe2b57b8971ce4aba324e6b', after='08e21b6763b1f957ccd4fc629d22b0f8e77e032396052cd189ac37a316024f36';
  let {content}=await read(root,path,old);
  content=replaceOnce(content,"const useTextCompanion=mediaUsesTextCompanion(post.content_type,text)||richEmojiTextTransport;","const useTextCompanion=mediaUsesTextCompanion(post.content_type,text);",'nexcanal album companion');
  content=replaceOnce(content,"const useTextCompanion=kind!=='VIDEO_NOTE'&&(mediaUsesTextCompanion(kind,text)||richEmojiTextTransport);","const useTextCompanion=kind!=='VIDEO_NOTE'&&mediaUsesTextCompanion(kind,text);",'nexcanal single media companion');
  content=replaceOnce(content,"const needsCompanion=mediaUsesTextCompanion(post.content_type,text)||richEmojiTextTransport;","const needsCompanion=mediaUsesTextCompanion(post.content_type,text);",'nexcanal edit companion');
  await write(root,path,content,old,after);
}
{
  const root='nexcanal', path='dist/src/services/publisher.js', old='e869d5ca1c23f457e4f6d046b06c2940f9c89e47701c3772e8f2b74325e9ec51', after='159b18addc5b4ec49e349f2775942fbafadc80e5ec5685f9787f2db569b2584e';
  let {content}=await read(root,path,old);
  content=replaceOnce(content,"const useTextCompanion = mediaUsesTextCompanion(post.content_type, text) || richEmojiTextTransport;","const useTextCompanion = mediaUsesTextCompanion(post.content_type, text);",'nexcanal dist album companion');
  content=replaceOnce(content,"const useTextCompanion = kind !== 'VIDEO_NOTE' && (mediaUsesTextCompanion(kind, text) || richEmojiTextTransport);","const useTextCompanion = kind !== 'VIDEO_NOTE' && mediaUsesTextCompanion(kind, text);",'nexcanal dist single media companion');
  content=replaceOnce(content,"const needsCompanion = mediaUsesTextCompanion(post.content_type, text) || richEmojiTextTransport;","const needsCompanion = mediaUsesTextCompanion(post.content_type, text);",'nexcanal dist edit companion');
  await write(root,path,content,old,after);
}
{
  const root='nexcanal', path='tests/v66-channel-rich-custom-emoji.test.ts', old='858e46bcd0a0aa5294fb21156a865569e735de110f8007f540db00768eb8e80d', after='15fcab081b423db91175d84ee33ec3a7e9acaf09259a21fce766dd5a3c92caa2';
  let {content}=await read(root,path,old);
  content=replaceOnce(content,"test('media channel publication with custom emoji uses a Rich companion so Telegram channels render it',async()=>{","test('media channel publication with custom emoji keeps native caption when it fits Telegram caption limit',async()=>{",'nexcanal regression test name');
  content=replaceOnce(content,"  assert.equal(photoCaption,undefined,'custom emoji caption is moved out of the restricted native channel caption transport');\n  assert.equal(richCalls,1,'custom emoji media publication must create one Rich companion');\n  assert.match(String(richPayload?.html||''),/<tg-emoji emoji-id=\"999000\">✨<\\/tg-emoji>/);\n  assert.equal(photoExtra?.caption_entities,undefined);","  assert.equal(photoCaption,'Look ✨','media text stays attached to the photo as a native Telegram caption');\n  assert.equal(richCalls,0,'fitting media captions must not create a separate Rich companion message');\n  assert.equal(richPayload,null);\n  assert.deepEqual(photoExtra?.caption_entities,[{type:'custom_emoji',offset:5,length:1,custom_emoji_id:'999000'}]);",'nexcanal regression assertions');
  await write(root,path,content,old,after);
}

// NEXGROUP: do not block group commands on optional admin lookup, and never block owner /start on Nexus membership network gating.
{
  const root='nexgroup', path='src/runtime/app.ts', old='11e02579de0f7abb1ad3e0700d41aeb4b376ad0268c9acfbf274813323091b56', after='9e1d8dbdb1a34fbfa1b7588fa6b7ffa04bd30f613475ad364ce3345508549cd2';
  let {content}=await read(root,path,old);
  const from1=`    const admin=await this.userIsGroupAdmin(group,user);\n    const whitelisted=await this.s.store.isWhitelisted(group.id,Number(user.telegram_user_id),[],user.username??undefined).catch(()=>false);`;
  const to1=`    const raw=(message.text??message.caption??'');\n    const isCommand=Boolean(parseCommand(raw));\n    const needsAdminException=Boolean(\n      (message.forward_origin&&config.management.forwarding.mode!=='ALLOW'&&config.management.forwarding.allowAdmins) ||\n      (message.reply_to_message&&!isCommand&&config.management.quotedReplies.mode==='DELETE'&&config.management.quotedReplies.allowAdmins)\n    );\n    // Do not block the command dispatcher on an optional getChatMember round-trip.\n    // Exact command authorization is performed later by requirePermission()/auth.check().\n    const admin=needsAdminException?await this.userIsGroupAdmin(group,user):false;\n    const whitelisted=await this.s.store.isWhitelisted(group.id,Number(user.telegram_user_id),[],user.username??undefined).catch(()=>false);`;
  content=replaceOnce(content,from1,to1,'nexgroup command preflight');
  content=replaceOnce(content,"    const isCommand=Boolean(parseCommand(message.text??message.caption??''));\n",'', 'nexgroup duplicate isCommand');
  content=replaceOnce(content,"    const raw=(message.text??message.caption??'');\n",'', 'nexgroup duplicate raw');
  const from2=`    const gating=await this.s.nexus.verify(Number(user.telegram_user_id));if(!gating.dashboardAllowed)return this.showNexus(user,locale);`;
  const to2=`    // The Nexus owner must never lose /start because a membership-verification\n    // request is slow or temporarily unavailable. Every sensitive group action still\n    // performs its own Telegram/authorization checks before mutation.\n    if(!this.isUsageAdmin(user)){\n      const timeout=Symbol('nexus-timeout');\n      const gating=await Promise.race([this.s.nexus.verify(Number(user.telegram_user_id)),new Promise<typeof timeout>((resolve)=>setTimeout(()=>resolve(timeout),8000))]);\n      if(gating===timeout){\n        await this.sendPrivate(Number(user.telegram_user_id),locale,translateRuntimeText(locale,'⚠️ Nexus membership verification is temporarily slow. The dashboard was not blocked permanently; retry in a few seconds.'),{reply_markup:callbackMarkup([[{text:'🔄',data:'nav:home'}],[{text:ui(locale,'button.support'),url:this.env.NEXUS_SUPPORT_URL}]])});\n        return;\n      }\n      if(!gating.dashboardAllowed)return this.showNexus(user,locale);\n    }`;
  content=replaceOnce(content,from2,to2,'nexgroup owner start gating');
  await write(root,path,content,old,after);
}
{
  const root='nexgroup', path='dist/runtime/app.js', old='77da6eb29a9e122003b76aeea73bc56ae9008c141da7ca4873cff33aeeb01d6f', after='2f00547c52ba4ff54ac9006e4289c8d6ded29e691d5fdde63195b0b57ff891f8';
  let {content}=await read(root,path,old);
  const from1=`        const admin = await this.userIsGroupAdmin(group, user);\n        const whitelisted = await this.s.store.isWhitelisted(group.id, Number(user.telegram_user_id), [], user.username ?? undefined).catch(() => false);`;
  const to1=`        const raw = (message.text ?? message.caption ?? '');\n        const isCommand = Boolean(parseCommand(raw));\n        const needsAdminException = Boolean((message.forward_origin && config.management.forwarding.mode !== 'ALLOW' && config.management.forwarding.allowAdmins) ||\n            (message.reply_to_message && !isCommand && config.management.quotedReplies.mode === 'DELETE' && config.management.quotedReplies.allowAdmins));\n        // Do not block the command dispatcher on an optional getChatMember round-trip.\n        // Exact command authorization is performed later by requirePermission()/auth.check().\n        const admin = needsAdminException ? await this.userIsGroupAdmin(group, user) : false;\n        const whitelisted = await this.s.store.isWhitelisted(group.id, Number(user.telegram_user_id), [], user.username ?? undefined).catch(() => false);`;
  content=replaceOnce(content,from1,to1,'nexgroup dist command preflight');
  content=replaceOnce(content,"        const isCommand = Boolean(parseCommand(message.text ?? message.caption ?? ''));\n",'', 'nexgroup dist duplicate isCommand');
  content=replaceOnce(content,"        const raw = (message.text ?? message.caption ?? '');\n",'', 'nexgroup dist duplicate raw');
  const from2=`        const gating = await this.s.nexus.verify(Number(user.telegram_user_id));\n        if (!gating.dashboardAllowed)\n            return this.showNexus(user, locale);`;
  const to2=`        // The Nexus owner must never lose /start because a membership-verification\n        // request is slow or temporarily unavailable. Every sensitive group action still\n        // performs its own Telegram/authorization checks before mutation.\n        if (!this.isUsageAdmin(user)) {\n            const timeout = Symbol('nexus-timeout');\n            const gating = await Promise.race([this.s.nexus.verify(Number(user.telegram_user_id)), new Promise((resolve) => setTimeout(() => resolve(timeout), 8000))]);\n            if (gating === timeout) {\n                await this.sendPrivate(Number(user.telegram_user_id), locale, translateRuntimeText(locale, '⚠️ Nexus membership verification is temporarily slow. The dashboard was not blocked permanently; retry in a few seconds.'), { reply_markup: callbackMarkup([[{ text: '🔄', data: 'nav:home' }], [{ text: ui(locale, 'button.support'), url: this.env.NEXUS_SUPPORT_URL }]]) });\n                return;\n            }\n            if (!gating.dashboardAllowed)\n                return this.showNexus(user, locale);\n        }`;
  content=replaceOnce(content,from2,to2,'nexgroup dist owner start gating');
  await write(root,path,content,old,after);
}
{
  const root='nexgroup', path='tests/v6108-start-command-preflight-regression.test.ts', after='0d5f12874a478a8f83845ae102036a1e851a5609fca892cfa9192e1eba1e5440';
  const content=`import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n\nconst app=fs.readFileSync(new URL('../src/runtime/app.ts',import.meta.url),'utf8');\n\ntest('owner /start dashboard bypasses slow Nexus network gating',()=>{\n  const start=app.indexOf('private async showDashboard');\n  const end=app.indexOf('private async showGroupDashboard',start);\n  const block=app.slice(start,end);\n  assert.match(block,/if\\(!this\\.isUsageAdmin\\(user\\)\\)/);\n  assert.match(block,/Promise\\.race/);\n  assert.match(block,/8000/);\n  assert.match(block,/this\\.s\\.nexus\\.verify/);\n});\n\ntest('group command dispatch does not require an unnecessary admin lookup before command parsing',()=>{\n  const start=app.indexOf('private async applyMessageManagementPolicy');\n  const end=app.indexOf('private async',start+20);\n  const block=app.slice(start,end);\n  assert.match(block,/const isCommand=Boolean\\(parseCommand\\(raw\\)\\)/);\n  assert.match(block,/const needsAdminException=Boolean/);\n  assert.match(block,/needsAdminException\\?await this\\.userIsGroupAdmin/);\n  assert.doesNotMatch(block,/const admin=await this\\.userIsGroupAdmin/);\n});\n`;
  let exists=false;
  try{const j=await run('fs.read',{root,path},60000); if(j?.result?.sha256===after){exists=true; console.log('[write] regression test already present')} else throw new Error(`Unexpected existing ${root}/${path} sha=${j?.result?.sha256}`)}catch(e){if(!String(e.message).includes('ENOENT')&&!String(e.message).includes('No such file')){if(!String(e.message).includes('Agent job')||!String(e.message).includes('ENOENT')) throw e}}
  if(!exists) await write(root,path,content,null,after);
}

for(const [root,check,file,timeoutMs] of [
  ['nexcanal','node-check','dist/src/services/publisher.js',30000],
  ['nexgroup','node-check','dist/runtime/app.js',30000],
  ['nexcanal','npm-test',null,180000],
  ['nexgroup','npm-test',null,180000],
]){
  const payload={root,check,timeoutMs}; if(file) payload.file=file;
  const j=await run('check.run',payload,timeoutMs+30000);
  if(j.result?.ok!==true) throw new Error(`Check failed ${root}/${check}: ${String(j.result?.stderr||j.result?.stdout||'').slice(-4000)}`);
  console.log(`[check] OK ${root}/${check}`);
}

for(const target of ['nexcanal','nexgroup']){
  await run('runtime.restart',{target,reason:'NexControl v61.08.1 verified hotfix'},60000);
  console.log(`[restart] queued ${target}`);
  await sleep(5000);
}

for(const [root,path,expected] of [
  ['nexcanal','dist/src/services/publisher.js','159b18addc5b4ec49e349f2775942fbafadc80e5ec5685f9787f2db569b2584e'],
  ['nexgroup','dist/runtime/app.js','2f00547c52ba4ff54ac9006e4289c8d6ded29e691d5fdde63195b0b57ff891f8'],
]){
  const j=await run('fs.read',{root,path},60000);
  if(j.result?.sha256!==expected) throw new Error(`Final SHA mismatch ${root}/${path}: ${j.result?.sha256}`);
  console.log(`[verify] OK ${root}/${path} ${expected}`);
}

try{
  const j=await run('logs.tail',{log:'launcher',bytes:60000},60000);
  console.log('[launcher-tail]\n'+String(j.result?.content||'').split(/\r?\n/).slice(-40).join('\n'));
}catch(e){console.log('[launcher-tail] unavailable: '+e.message)}

console.log('[hotfix] SUCCESS v61.08.1 applied, tested, restarted, verified');
