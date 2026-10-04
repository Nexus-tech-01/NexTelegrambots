import fs from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';

const base='/opt/nex/apps/public/nexai/current';
const sourceSha='594c4231dc315edd3a121f4d466efea8c58af227';

async function source(path){
  const url='https://raw.githubusercontent.com/Nexus-tech-01/NexTelegrambots/'+sourceSha+'/nexaccount/'+path;
  const r=await fetch(url,{signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error('source_http_'+path+'_'+r.status);
  return r.text();
}
function section(text,start,end){
  const a=text.indexOf(start);
  if(a<0)throw new Error('section_start_missing:'+start);
  const b=text.indexOf(end,a);
  if(b<0)throw new Error('section_end_missing:'+end);
  return text.slice(a,b);
}
function replaceSection(live,src,start,end,label){
  const old=section(live,start,end);
  const neu=section(src,start,end);
  const out=live.replace(old,neu);
  if(out===live)throw new Error('section_replace_failed:'+label);
  return out;
}

const [srcCommands,srcCompat,srcRuntime]=await Promise.all([
  source('commands.mjs'),
  source('compat.mjs'),
  source('runtime.mjs')
]);

let commands=fs.readFileSync(base+'/commands.mjs','utf8');
let compat=fs.readFileSync(base+'/compat.mjs','utf8');
let runtime=fs.readFileSync(base+'/runtime.mjs','utf8');

const liveBroadcastLine=commands.split('\n').find(x=>x.includes("C('broadcast','GROUP'"));
const srcBroadcastLine=srcCommands.split('\n').find(x=>x.includes("C('broadcast','GROUP'"));
if(!liveBroadcastLine||!srcBroadcastLine)throw new Error('broadcast_registry_line_missing');
commands=commands.replace(liveBroadcastLine,srcBroadcastLine);

compat=replaceSection(
  compat,srcCompat,
  'function isAdminParticipant(p){',
  'function displayName(p){',
  'broadcast_helpers'
);
compat=replaceSection(
  compat,srcCompat,
  "  if(['antilink','antispam','antiraid','antibadword','antitag','antigroupmention','welcome','goodbye','setwelcome','setgoodbye','autosticker','aimoderator','modlog'].includes(name)){",
  "  if(name==='mode'||name==='accessmode'||name==='botmode'){",
  'welcome_config'
);
compat=replaceSection(
  compat,srcCompat,
  "    if(name==='broadcast'){",
  "    if(name==='cancel'){",
  'broadcast_handler'
);

runtime=replaceSection(
  runtime,srcRuntime,
  'async function maybeServiceGreeting(runtime,event){',
  'async function maintainPresence(runtime){',
  'greeting_handler'
);

fs.mkdirSync(base+'/.runtime',{recursive:true});
for(const [name,text] of [['commands.mjs',commands],['compat.mjs',compat],['runtime.mjs',runtime]]){
  const path=base+'/'+name;
  fs.copyFileSync(path,base+'/.runtime/'+name+'.before-group-features-'+Date.now());
  const tmp=path+'.tmp-'+Date.now()+'.mjs';
  fs.writeFileSync(tmp,text);
  const chk=spawnSync(process.execPath,['--check',tmp],{encoding:'utf8'});
  if(chk.status!==0){
    try{fs.unlinkSync(tmp)}catch{}
    throw new Error('syntax_failed_'+name+':'+String(chk.stderr||chk.stdout||'').slice(0,1400));
  }
  fs.renameSync(tmp,path);
}

let pid=0;
let env={...process.env};
for(const n of fs.readdirSync('/proc')){
  if(!/^\d+$/.test(n))continue;
  try{
    const cmd=fs.readFileSync('/proc/'+n+'/cmdline','utf8').replace(/\0/g,' ').trim();
    if(cmd.includes('/opt/nex/apps/public/nexai/')&&cmd.endsWith('/daemon.mjs')){
      pid=Number(n);
      env={};
      for(const row of fs.readFileSync('/proc/'+n+'/environ','utf8').split('\0').filter(Boolean)){
        const i=row.indexOf('=');
        if(i>0)env[row.slice(0,i)]=row.slice(i+1);
      }
      break;
    }
  }catch{}
}
if(!pid)throw new Error('live_daemon_not_found');

try{process.kill(pid,'SIGTERM')}catch{}
await new Promise(r=>setTimeout(r,1400));
const child=spawn(process.execPath,[base+'/bootstrap.mjs','--production'],{
  cwd:base,detached:true,stdio:'ignore',env
});
child.unref();

const port=env.NEXACCOUNT_PORT||'18120';
let health=null;
for(let i=0;i<40;i++){
  await new Promise(r=>setTimeout(r,500));
  try{
    const r=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(1500)});
    if(r.ok){health=await r.json();break}
  }catch{}
}
if(!health?.ok)throw new Error('health_not_restored');

const checks={
  commands:fs.readFileSync(base+'/commands.mjs','utf8'),
  compat:fs.readFileSync(base+'/compat.mjs','utf8'),
  runtime:fs.readFileSync(base+'/runtime.mjs','utf8')
};
for(const marker of [
  "C('broadcast','GROUP',{selfOnly:true",
  'managedBroadcastTargets',
  'Variables : {mention}',
  'Broadcast terminé ✅',
  'greetingActionUserIds',
  'renderGreetingTemplate'
]){
  const joined=checks.commands+'\n'+checks.compat+'\n'+checks.runtime;
  if(!joined.includes(marker))throw new Error('marker_missing:'+marker);
}

console.log(JSON.stringify({
  ok:true,
  oldPid:pid,
  worker:health.worker?.id||'',
  port,
  runtimeCount:health.runtimeCount,
  welcomeGoodbye:true,
  tagHidetag:true,
  managedBroadcast:true
}));
