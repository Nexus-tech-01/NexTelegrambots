import fs from 'node:fs';
import {spawn} from 'node:child_process';

const base='/opt/nex/apps/public/nexai/current';
const p=base+'/inline-bot.mjs';
const sourceUrl='https://raw.githubusercontent.com/Nexus-tech-01/NexTelegrambots/8c73ad72c52fd067c8e03bc5a37e8f66fe75ae12/nexaccount/inline-bot.mjs';

const response=await fetch(sourceUrl,{signal:AbortSignal.timeout(30000)});
if(!response.ok)throw new Error('source_http_'+response.status);
const src=await response.text();
let live=fs.readFileSync(p,'utf8');

function section(text,start,end){
  const a=text.indexOf(start);
  if(a<0)throw new Error('section_start_missing:'+start);
  const b=text.indexOf(end,a);
  if(b<0)throw new Error('section_end_missing:'+end);
  return text.slice(a,b);
}

const start='async function sendStart(ctx){';
const end='async function sendCreator(ctx){';
const srcStart=section(src,start,end);
const liveStart=section(live,start,end);
live=live.replace(liveStart,srcStart);

const backup=base+'/.runtime/inline-bot.before-start-layout-'+Date.now()+'.mjs';
fs.mkdirSync(base+'/.runtime',{recursive:true});
fs.copyFileSync(p,backup);
fs.writeFileSync(p,live);

let pid=0;
let env={...process.env};
for(const n of fs.readdirSync('/proc')){
  if(!/^\d+$/.test(n))continue;
  try{
    const cmd=fs.readFileSync('/proc/'+n+'/cmdline','utf8').replace(/\0/g,' ').trim();
    if(cmd==='/usr/bin/node '+base+'/daemon.mjs'||cmd==='node '+base+'/daemon.mjs'){
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
await new Promise(r=>setTimeout(r,1200));

const child=spawn(process.execPath,[base+'/bootstrap.mjs','--production'],{
  cwd:base,detached:true,stdio:'ignore',env
});
child.unref();

const port=env.NEXACCOUNT_PORT||'18120';
let health=null;
for(let i=0;i<30;i++){
  await new Promise(r=>setTimeout(r,500));
  try{
    const r=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(1500)});
    if(r.ok){health=await r.json();break}
  }catch{}
}
if(!health?.ok)throw new Error('health_not_restored');

const check=fs.readFileSync(p,'utf8');
if(!check.includes('caption_entities:quotedEntities(text'))throw new Error('caption_layout_missing');
if(!check.includes("if(account?.enabled===true)"))throw new Error('connected_start_route_missing');

console.log(JSON.stringify({
  ok:true,
  oldPid:pid,
  worker:health.worker?.id||'',
  botUsername:health.botUsername||'',
  captionAttached:true,
  connectedStartMenu:true
}));
