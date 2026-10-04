import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT='/opt/nex/apps/public/stacy/current';
const INDEX=path.join(ROOT,'src/index.js');
const HELPER=path.join(ROOT,'src/ops/ensureNexGroupAdmin.js');
const RESULT=path.join(ROOT,'.nexgroup-admin-result.json');
const startedAt=Date.now();

const helper = String.raw`const fs = require('node:fs');

module.exports = async function ensureNexGroupAdmin(bot) {
  const resultPath = '/opt/nex/apps/public/stacy/current/.nexgroup-admin-result.json';
  const targetRef = process.env.STACY_NEXAI_GROUP_CHAT || '@Tresortelegramgroup';
  const targetUserId = Number(process.env.STACY_NEXGROUP_BOT_ID || 8646461935);
  const rights = [
    'can_manage_chat',
    'can_delete_messages',
    'can_manage_video_chats',
    'can_restrict_members',
    'can_promote_members',
    'can_change_info',
    'can_invite_users',
    'can_pin_messages',
    'can_manage_topics',
    'can_post_stories',
    'can_edit_stories',
    'can_delete_stories'
  ];
  const save = (data) => {
    try { fs.writeFileSync(resultPath, JSON.stringify({ ...data, at: new Date().toISOString() }, null, 2)); } catch (_) {}
  };

  try {
    const me = await bot.telegram.getMe();
    const chat = await bot.telegram.getChat(targetRef);
    const title = String(chat?.title || '');
    const username = String(chat?.username || '').toLowerCase();

    if (username !== 'tresortelegramgroup' && !title.toLowerCase().includes('nexai group test')) {
      throw new Error('target_chat_mismatch:' + title + ':' + username);
    }

    const targetBefore = await bot.telegram.getChatMember(chat.id, targetUserId);
    const targetUsername = String(targetBefore?.user?.username || '').toLowerCase();
    if (targetUsername && targetUsername !== 'darknexus01_bot') {
      throw new Error('target_bot_mismatch:' + targetUsername);
    }

    const own = await bot.telegram.getChatMember(chat.id, me.id);
    if (!['administrator','creator'].includes(String(own?.status || ''))) {
      throw new Error('stacy_not_admin');
    }
    if (own.status !== 'creator' && own.can_promote_members !== true) {
      throw new Error('stacy_cannot_promote_members');
    }

    const extra = { is_anonymous: false };
    const unavailable = [];
    for (const right of rights) {
      const canGrant = own.status === 'creator' || own[right] === true;
      if (canGrant) extra[right] = true;
      else unavailable.push(right);
    }

    await bot.telegram.promoteChatMember(chat.id, targetUserId, extra);
    const after = await bot.telegram.getChatMember(chat.id, targetUserId);
    const granted = Object.fromEntries(rights.map((r) => [r, after?.[r] === true]));
    const expected = rights.filter((r) => extra[r] === true);
    const missing = expected.filter((r) => after?.[r] !== true);
    const allGranted = rights.every((r) => after?.[r] === true);
    const ok = after?.status === 'administrator' && missing.length === 0 && unavailable.length === 0 && allGranted;

    const report = {
      ok,
      chat: { id: chat.id, title, username: chat.username || null },
      stacy: { id: me.id, username: me.username || null, status: own.status },
      nexgroup: {
        id: targetUserId,
        username: targetBefore?.user?.username || null,
        beforeStatus: targetBefore?.status || null,
        afterStatus: after?.status || null
      },
      granted,
      unavailableFromStacy: unavailable,
      missingAfterPromotion: missing
    };

    save(report);
    return report;
  } catch (err) {
    const report = { ok:false, error:String(err?.message || err) };
    save(report);
    return report;
  }
};
`;

function readProc(pid, name) {
  try { return fs.readFileSync('/proc/'+pid+'/'+name); } catch { return null; }
}
function procInfo(pid) {
  const cmd=readProc(pid,'cmdline');
  const status=readProc(pid,'status');
  if(!cmd||!status)return null;
  const cmdline=cmd.toString('utf8').split('\0').filter(Boolean).join(' ');
  const m=status.toString('utf8').match(/^PPid:\s+(\d+)$/m);
  return {pid:Number(pid),ppid:Number(m?.[1]||0),cmdline};
}
function allProcs(){
  return fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x)).map(procInfo).filter(Boolean);
}
function findStacy(procs){
  const wrapper=procs.find(p=>p.cmdline.includes('/opt/nex/apps/public/stacy/current/nexus-bot.json'));
  const child=wrapper ? procs.find(p=>p.ppid===wrapper.pid && /(?:^|\s)(?:\/usr\/bin\/)?node\s+src\/index\.js(?:\s|$)/.test(p.cmdline)) : null;
  return {wrapper,child};
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const backupIndex=INDEX+'.pre-nexgroup-admin-'+stamp+'.bak';
const backupHelper=HELPER+'.pre-nexgroup-admin-'+stamp+'.bak';

await fsp.mkdir(path.dirname(HELPER),{recursive:true});
await fsp.copyFile(INDEX,backupIndex);
if(fs.existsSync(HELPER))await fsp.copyFile(HELPER,backupHelper);

let index=await fsp.readFile(INDEX,'utf8');
const requireLine="const ensureNexGroupAdmin = require('./ops/ensureNexGroupAdmin'); // NEXGROUP_ADMIN_ENSURE_V1";
if(!index.includes('NEXGROUP_ADMIN_ENSURE_V1')){
  const anchor="const logger = require('./utils/logger');";
  if(!index.includes(anchor))throw new Error('index_require_anchor_missing');
  index=index.replace(anchor,anchor+'\n'+requireLine);

  const launch='  await launchBot(bot);';
  if(!index.includes(launch))throw new Error('index_launch_anchor_missing');
  index=index.replace(
    launch,
    "  const nexGroupAdmin = await ensureNexGroupAdmin(bot);\n" +
    "  if (nexGroupAdmin?.ok) logger.info('nexgroup-admin', 'NexGroup admin rights verified.');\n" +
    "  else logger.warn('nexgroup-admin', 'NexGroup admin rights not fully applied: ' + JSON.stringify(nexGroupAdmin));\n" +
    launch
  );
}
await fsp.writeFile(HELPER,helper,'utf8');
await fsp.writeFile(INDEX,index,'utf8');

for(const file of [HELPER,INDEX]){
  const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if(r.status!==0){
    await fsp.copyFile(backupIndex,INDEX);
    if(fs.existsSync(backupHelper))await fsp.copyFile(backupHelper,HELPER);
    else await fsp.rm(HELPER,{force:true});
    throw new Error('syntax_check_failed:'+path.basename(file)+':'+String(r.stderr||'').slice(-1500));
  }
}

await fsp.rm(RESULT,{force:true});
const before=findStacy(allProcs());
if(!before.wrapper)throw new Error('stacy_supervisor_not_found');
if(!before.child)throw new Error('stacy_child_not_found');
process.kill(before.child.pid,'SIGTERM');

let result=null;
let after=null;
const deadline=Date.now()+30000;
while(Date.now()<deadline){
  await sleep(800);
  after=findStacy(allProcs());
  try{
    const st=fs.statSync(RESULT);
    if(st.mtimeMs>=startedAt){
      result=JSON.parse(fs.readFileSync(RESULT,'utf8'));
      break;
    }
  }catch{}
}

console.log(JSON.stringify({
  ok:result?.ok===true,
  patched:true,
  backupIndex,
  previousPid:before.child.pid,
  currentPid:after?.child?.pid||null,
  restarted:Boolean(after?.child?.pid && after.child.pid!==before.child.pid),
  result
}));
if(result?.ok!==true)process.exitCode=2;
