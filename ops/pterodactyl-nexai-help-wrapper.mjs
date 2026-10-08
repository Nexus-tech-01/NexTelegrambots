import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';

const ROOT='/home/container';
const NEX=path.join(ROOT,'bots','nexaccount');
const RESULT=path.join(ROOT,'nexai-help-deploy-result.json');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function loadEnvFile(file){
  try{
    const text=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');
    for(const raw of text.split(/\r?\n/)){
      const line=raw.trim();
      if(!line||line.startsWith('#'))continue;
      const i=line.indexOf('=');
      if(i<1)continue;
      const key=line.slice(0,i).trim();
      if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))continue;
      let value=line.slice(i+1).trim();
      if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
      if(value!=='')process.env[key]=value;
    }
  }catch{}
}
loadEnvFile(path.join(ROOT,'.env'));
loadEnvFile(path.join(NEX,'.env'));
process.env.NEXACCOUNT_PAIRING_ONLY='false';

function runNode(args,timeout=120000){
  const r=spawnSync(process.execPath,args,{cwd:NEX,env:process.env,encoding:'utf8',timeout,maxBuffer:16*1024*1024});
  return {ok:r.status===0&&!r.error,code:r.status,stdout:String(r.stdout||'').trim(),stderr:String(r.stderr||r.error?.message||'').trim()};
}
function parseJson(text){try{return JSON.parse(String(text||'').trim()||'{}')}catch{return null}}
async function save(report){report.updatedAt=new Date().toISOString();await fsp.writeFile(RESULT,JSON.stringify(report,null,2))}

const report={ok:false,startedAt:new Date().toISOString(),commit:'d2555a0b602ac784c28c498a8d0ade506fd5dc20',channel:'@Nextech_NexAi',steps:{}};
await save(report);

const boot=runNode([path.join(NEX,'bootstrap.mjs'),'--restart','--production'],150000);
report.steps.bootstrap={ok:boot.ok,code:boot.code,stdout:boot.stdout.slice(-5000),stderr:boot.stderr.slice(-5000)};
await save(report);

const launcher=spawn(process.execPath,[path.join(ROOT,'index.js')],{cwd:ROOT,env:process.env,stdio:'inherit'});
report.steps.launcher={started:true,pid:launcher.pid};
await save(report);

let fr=null,en=null,health=null;
for(let i=0;i<90;i++){
  const h=runNode([path.join(NEX,'cli.mjs'),'health'],30000);
  health=parseJson(h.stdout);
  const a=runNode([path.join(NEX,'cli.mjs'),'help-link','help','fr'],30000);
  const b=runNode([path.join(NEX,'cli.mjs'),'help-link','help','en'],30000);
  fr=parseJson(a.stdout); en=parseJson(b.stdout);
  report.steps.probe={attempt:i+1,health:health||{ok:false},fr:fr||{ok:false},en:en||{ok:false}};
  await save(report);
  if(health?.ok===true&&fr?.ok===true&&en?.ok===true)break;
  await sleep(4000);
}

if(!(fr?.ok===true&&en?.ok===true)){
  const sync=runNode([path.join(NEX,'cli.mjs'),'help-sync','fr','en'],720000);
  report.steps.fallbackSync={ok:sync.ok,code:sync.code,data:parseJson(sync.stdout),stderr:sync.stderr.slice(-5000)};
  const a=runNode([path.join(NEX,'cli.mjs'),'help-link','help','fr'],30000);
  const b=runNode([path.join(NEX,'cli.mjs'),'help-link','help','en'],30000);
  fr=parseJson(a.stdout); en=parseJson(b.stdout);
}

report.fr=fr; report.en=en; report.health=health;
report.ok=Boolean(boot.ok&&health?.ok===true&&fr?.ok===true&&en?.ok===true);
report.finishedAt=new Date().toISOString();
await save(report);
console.log('[NexAI help deploy]',JSON.stringify({ok:report.ok,fr:fr?.url||null,en:en?.url||null}));

await new Promise(resolve=>{
  launcher.once('exit',(code,signal)=>{
    report.steps.launcherExit={code,signal:signal||null,at:new Date().toISOString()};
    save(report).finally(resolve);
  });
});
process.exit(launcher.exitCode??0);
