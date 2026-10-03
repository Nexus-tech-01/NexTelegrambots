import fs from 'node:fs';
import {spawn} from 'node:child_process';

const base='/opt/nex/apps/public/nexai/current';
const p=base+'/inline-bot.mjs';
let t=fs.readFileSync(p,'utf8');

const old=`      return await ctx.replyWithVideo(tutorial.fileId,{
        caption,
        supports_streaming:true,
        reply_markup:connectMarkup(lang)
      });`;

const neu=`      return await ctx.replyWithVideo(tutorial.fileId,{
        caption,
        supports_streaming:true,
        reply_markup:{
          inline_keyboard:[[
            {
              text:lang==='en'?'Open Mini App':'Ouvrir la Mini App',
              web_app:{url:'https://nex-telegrambots.vercel.app/'}
            }
          ]]
        }
      });`;

if(!t.includes(old))throw new Error('live_tutorial_video_block_missing');
t=t.replace(old,neu);
fs.writeFileSync(p,t);

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
if(check.includes("caption,\n        supports_streaming:true,\n        reply_markup:connectMarkup(lang)")){
  throw new Error('duplicate_tutorial_markup_still_present');
}

console.log(JSON.stringify({
  ok:true,
  oldPid:pid,
  port,
  botUsername:health.botUsername,
  worker:health.worker?.id||'',
  duplicateRemoved:true
}));
