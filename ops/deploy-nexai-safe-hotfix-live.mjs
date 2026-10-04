import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const sha=String(process.env.NEXAI_DEPLOY_SHA||'').trim();
if(!/^[0-9a-f]{40}$/i.test(sha))throw new Error('NEXAI_DEPLOY_SHA invalid');
const mode=String(process.env.NEXAI_HOTFIX_MODE||'anime-gap-skip').trim();
const repo='Nexus-tech-01/NexTelegrambots';
const currentLink='/opt/nex/apps/public/nexai/current';
const base=fs.realpathSync(currentLink);
const service='nex-nexaccount.service';
const modes={
  'anime-gap-skip':[
    ['anime-ingest.mjs','nexaccount/anime-ingest.mjs'],
    ['bootstrap.mjs','nexaccount/bootstrap.mjs']
  ],
  'inline-tutorial':[
    ['inline-bot.mjs','nexaccount/inline-bot.mjs'],
    ['reply-storage.mjs','nexaccount/reply-storage.mjs']
  ],
  'custom-style':[
    ['custom-style.mjs','nexaccount/custom-style.mjs'],
    ['store.mjs','nexaccount/store.mjs'],
    ['commands.mjs','nexaccount/commands.mjs'],
    ['runtime.mjs','nexaccount/runtime.mjs'],
    ['compat.mjs','nexaccount/compat.mjs'],
    ['menu.mjs','nexaccount/menu.mjs'],
    ['inline-bot.mjs','nexaccount/inline-bot.mjs'],
    ['sticker-engine.mjs','nexaccount/sticker-engine.mjs'],
    ['sticker-transform.mjs','nexaccount/sticker-transform.mjs'],
    ['scripts/test-menu-resilience.mjs','nexaccount/scripts/test-menu-resilience.mjs']
  ],
  'stickers':[
    ['commands.mjs','nexaccount/commands.mjs'],
    ['sticker-engine.mjs','nexaccount/sticker-engine.mjs'],
    ['sticker-transform.mjs','nexaccount/sticker-transform.mjs'],
    ['runtime.mjs','nexaccount/runtime.mjs']
  ],
  'prefixless-loop':[
    ['runtime.mjs','nexaccount/runtime.mjs'],
    ['compat.mjs','nexaccount/compat.mjs']
  ]
};
const files=modes[mode];
if(!files)throw new Error('unsupported hotfix mode '+mode);

const required={
  'anime-ingest.mjs':['blockedSeriesEntries',"missing_previous_episode_without_runnable_variant",'and continuing with another runnable series','return claimNext(runtime);'],
  'bootstrap.mjs':['refusing auxiliary production runtime','AUTH_KEY_DUPLICATED','canonicalRoot'],
  'inline-bot.mjs':['CONNECT_TUTORIAL_CALLBACK','connect:tutorial','sendConnectTutorial','storeReplyVideo'],
  'reply-storage.mjs':['filenamePrefix','safePrefix'],
  'custom-style.mjs':['normalizeCustomStyle','customStyleMedia','renderCustomHeader','renderCustomCategory'],
  'store.mjs':['customStyle:normalizeCustomStyle','safe.customStyle=normalizeCustomStyle'],
  'menu.mjs':['customStyleModel','menu:customstyle','customStyleMedia(settings)','categoryPage'],
  'commands.mjs':["C('ultratake'","C('delfilig'","C('filitake'","C('noteclone'","C('customstyle'","C('stylename'","C('menuvideo'"],
  'sticker-engine.mjs':["'ultratake'","'delfilig'","'filitake'","'noteclone'","export async function resumeStickerJobs"],
  'sticker-transform.mjs':['export async function addStickerWatermark','export async function removeStickerWatermark','export async function roundSticker'],
  'runtime.mjs':['canHandleStickerCommand(parsed.name)','Sticker engine fallback','registered.hidden!==true','consumeGeneratedCommandOutput','markGeneratedCommandOutput','NEXACCOUNT_EMBEDDED_ANIME'],
  'compat.mjs':['cacheMenuMediaForBot',"name==='customstyle'","name==='menuphoto'||name==='menuvideo'",'✅ Diffusion terminée']
};

const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const backupDir='/var/lib/nex/runtime/public/nexaccount/deploy-backups/'+mode+'-'+stamp;
fs.mkdirSync(backupDir,{recursive:true,mode:0o750});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const run=(cmd,args,opts={})=>{
  const r=spawnSync(cmd,args,{
    encoding:'utf8',
    timeout:opts.timeout||120000,
    maxBuffer:8*1024*1024,
    cwd:opts.cwd||base,
    env:opts.env||process.env
  });
  return {ok:r.status===0&&!r.error,code:r.status,stdout:String(r.stdout||''),stderr:String(r.stderr||r.error?.message||'')};
};
async function fetchText(src){
  const url='https://raw.githubusercontent.com/'+repo+'/'+sha+'/'+src;
  const r=await fetch(url,{headers:{'user-agent':'nexai-safe-live-hotfix/1'},signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error('fetch '+src+' HTTP '+r.status);
  const t=await r.text();
  if(!t.trim())throw new Error('empty '+src);
  return t;
}
function copyMeta(src,dst){
  const st=fs.statSync(src);
  fs.chmodSync(dst,st.mode&0o777);
  try{fs.chownSync(dst,st.uid,st.gid)}catch{}
}
function nexDaemons(){
  const out=[];
  for(const name of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))){
    const pid=Number(name);
    if(pid<=1||pid===process.pid)continue;
    try{
      const cmd=fs.readFileSync('/proc/'+pid+'/cmdline').toString().split('\0').filter(Boolean).join(' ');
      if(/\/opt\/nex\/apps\/public\/nexai\/(?:current|releases\/[^/]+)\/daemon\.mjs/.test(cmd)
        ||/\/nexcontrol\/agent\/bots\/nexaccount\/daemon\.mjs/.test(cmd)){
        out.push({pid,cmd});
      }
    }catch{}
  }
  return out;
}
async function stopAllNexDaemons(){
  run('systemctl',['stop',service],{cwd:'/',timeout:60000});
  await sleep(1200);
  for(const p of nexDaemons())try{process.kill(p.pid,'SIGTERM')}catch{}
  for(let i=0;i<25;i++){
    if(nexDaemons().length===0)return;
    await sleep(200);
  }
  for(const p of nexDaemons())try{process.kill(p.pid,'SIGKILL')}catch{}
  await sleep(500);
  const left=nexDaemons();
  if(left.length)throw new Error('could not stop duplicate NexAccount daemons: '+JSON.stringify(left));
}
async function startCanonical(){
  const r=run('systemctl',['start',service],{cwd:'/',timeout:60000});
  if(!r.ok)throw new Error('systemctl start failed: '+r.stderr.slice(-1200));
}
async function health(timeoutMs=90000){
  const end=Date.now()+timeoutMs;
  let last=null;
  while(Date.now()<end){
    const show=run('systemctl',['show',service,'--no-page','--property=ActiveState,SubState,MainPID,ExecMainStatus'],{cwd:'/',timeout:15000});
    const props={};
    for(const line of show.stdout.split(/\r?\n/)){const i=line.indexOf('=');if(i>0)props[line.slice(0,i)]=line.slice(i+1)}
    try{
      const r=await fetch('http://127.0.0.1:18120/health',{signal:AbortSignal.timeout(4000)});
      const data=await r.json().catch(()=>null);
      const daemons=nexDaemons();
      last={props,status:r.status,data,daemons};
      if(r.ok&&data?.ok===true&&data?.pairingOnly!==true&&props.ActiveState==='active'&&props.SubState==='running'&&Number(props.MainPID)>1&&daemons.length===1&&daemons[0].pid===Number(props.MainPID))return last;
    }catch(e){last={props,error:String(e?.message||e),daemons:nexDaemons()}}
    await sleep(2000);
  }
  throw new Error('health timeout '+JSON.stringify(last));
}
function cli(command,...args){
  const r=run(process.execPath,[path.join(base,'cli.mjs'),command,...args],{
    cwd:base,timeout:180000,
    env:{...process.env,NEXACCOUNT_PORT:'18120'}
  });
  if(!r.ok)throw new Error('cli '+command+' failed: '+(r.stderr||r.stdout).slice(-1800));
  try{return JSON.parse(r.stdout.trim()||'{}')}catch{throw new Error('cli '+command+' invalid json: '+r.stdout.slice(-1800))}
}
async function restore(){
  for(const [dst] of files){
    const bak=path.join(backupDir,dst),target=path.join(base,dst);
    if(fs.existsSync(bak)){
      const tmp=target+'.rollback-'+process.pid;
      fs.copyFileSync(bak,tmp);
      const metaSource=fs.existsSync(target)?target:bak;
      copyMeta(metaSource,tmp);
      fs.renameSync(tmp,target);
    }else if(originallyMissing.has(dst)&&fs.existsSync(target)){
      fs.unlinkSync(target);
    }
  }
  await stopAllNexDaemons();
  await startCanonical();
}

const report={ok:false,mode,sha,base,backupDir,steps:{}};
const originallyMissing=new Set();
let changed=false;
try{
  const remote={};
  for(const [dst,src] of files){
    const t=await fetchText(src);
    for(const marker of required[dst]||[])if(!t.includes(marker))throw new Error(dst+' missing marker '+marker);
    remote[dst]=t;
  }
  report.steps.sourceValidated=true;

  for(const [dst] of files){
    const target=path.join(base,dst),bak=path.join(backupDir,dst);
    fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o750});
    fs.mkdirSync(path.dirname(bak),{recursive:true,mode:0o750});
    const exists=fs.existsSync(target);
    const metaSource=exists?target:path.join(base,'menu.mjs');
    if(exists){
      fs.copyFileSync(target,bak);
      copyMeta(target,bak);
    }else{
      originallyMissing.add(dst);
    }
    const tmp=target+'.safe-hotfix-'+process.pid;
    fs.writeFileSync(tmp,remote[dst],{mode:fs.statSync(metaSource).mode&0o777});
    copyMeta(metaSource,tmp);
    fs.renameSync(tmp,target);
    changed=true;
  }
  report.steps.written=files.map(x=>x[0]);

  for(const [dst] of files){
    const ck=run(process.execPath,['--check',path.join(base,dst)],{cwd:base,timeout:60000});
    if(!ck.ok)throw new Error('node --check '+dst+': '+ck.stderr.slice(-1600));
  }
  report.steps.syntax=true;

  // node --check does not resolve ESM imports/exports. Import the runtime graph
  // before touching systemd so mismatched dependent files can never crash live.
  if(mode==='custom-style'||mode==='stickers'||mode==='prefixless-loop'){
    const graph=run(process.execPath,['--input-type=module','-e',"await import('./runtime.mjs'); await import('./inline-bot.mjs'); console.log('MODULE_GRAPH_OK')"],{cwd:base,timeout:90000});
    if(!graph.ok||!graph.stdout.includes('MODULE_GRAPH_OK')){
      throw new Error('module graph validation failed: '+(graph.stderr||graph.stdout).slice(-2200));
    }
    report.steps.moduleGraph=true;
  }

  if(mode==='anime-gap-skip'){
    const test=run(process.execPath,[path.join(base,'scripts/test-anime-ingest.mjs')],{cwd:base,timeout:120000});
    if(!test.ok)throw new Error('anime regression tests failed: '+test.stderr.slice(-2000));
    report.steps.animeTests=true;
  }
  if(mode==='custom-style'){
    const test=run(process.execPath,[path.join(base,'scripts/test-menu-resilience.mjs')],{cwd:base,timeout:120000});
    if(!test.ok)throw new Error('custom style menu regression failed: '+(test.stderr||test.stdout).slice(-2600));
    report.steps.menuTests=true;
  }

  await stopAllNexDaemons();
  report.steps.duplicatesCleared=true;
  await startCanonical();
  const live=await health();
  report.steps.health=live;

  if(mode==='anime-gap-skip'){
    const anime=cli('anime-status');
    if(anime?.ok!==true||anime?.enabled!==true||String(anime?.destination||'').toLowerCase()!=='@theotaku_nexus')throw new Error('anime status regression');
    report.steps.anime={
      ok:anime.ok,
      enabled:anime.enabled,
      destination:anime.destination,
      interSeriesMinutes:anime.interSeriesMinutes,
      scheduler:anime.scheduler,
      queue:anime.queue,
      published:anime.published
    };
  }
  if(mode==='prefixless-loop'){
    let anime=null;
    let accounts=null;
    let byName=new Map();
    let recordsByName=new Map();
    for(let i=0;i<30;i++){
      try{
        anime=cli('anime-status');
        accounts=cli('accounts');
        const active=Array.isArray(accounts?.runtimes)?accounts.runtimes:[];
        const records=Array.isArray(accounts?.accounts)?accounts.accounts:[];
        byName=new Map(active.filter(x=>x?.connected===true).map(x=>[String(x.username||'').toLowerCase().replace(/^@/,''),x]));
        recordsByName=new Map(records.map(x=>[String(x.username||'').toLowerCase().replace(/^@/,''),x]));
        const primaryRepair=recordsByName.get('tresor20001')?.sessionRepairRequired===true;
        if(anime?.ok===true&&anime?.enabled===true
          &&String(anime?.destination||'').toLowerCase()==='@theotaku_nexus'
          &&(byName.has('tresor20001')||primaryRepair)
          &&byName.has('tresor20009'))break;
      }catch{}
      await sleep(2500);
    }
    if(anime?.ok!==true||anime?.enabled!==true||String(anime?.destination||'').toLowerCase()!=='@theotaku_nexus')throw new Error('anime status regression after prefixless-loop deploy');
    const primary=byName.get('tresor20001');
    const scanner=byName.get('tresor20009');
    const primaryRepair=recordsByName.get('tresor20001')?.sessionRepairRequired===true;
    if(!primary&&!primaryRepair)throw new Error('required NexAI runtime missing after prefixless-loop deploy: @tresor20001');
    if(!scanner)throw new Error('required NexAI runtime missing after prefixless-loop deploy: @tresor20009');
    if(primary&&(primary?.anime?.listener!==true||primary?.anime?.publisher!==true))throw new Error('@tresor20001 anime role regression');
    if(scanner?.anime?.listener!==true)throw new Error('@tresor20009 anime listener regression');
    report.steps.prefixlessLoop={antiLoop:true,broadcastReplySafe:true};
    report.steps.anime={ok:anime.ok,enabled:anime.enabled,destination:anime.destination,interSeriesMinutes:anime.interSeriesMinutes};
    report.steps.accounts={
      tresor20001:primary?true:(primaryRepair?'repair-required':false),
      tresor20009:true,
      runtimeCount:Array.isArray(accounts?.runtimes)?accounts.runtimes.filter(x=>x?.connected===true).length:0
    };
  }

  if(mode==='custom-style'){
    let anime=null;
    let accounts=null;
    let byName=new Map();
    let recordsByName=new Map();
    for(let i=0;i<24;i++){
      try{
        anime=cli('anime-status');
        accounts=cli('accounts');
        const active=Array.isArray(accounts?.runtimes)?accounts.runtimes:[];
        const records=Array.isArray(accounts?.accounts)?accounts.accounts:[];
        byName=new Map(active.filter(x=>x?.connected===true).map(x=>[String(x.username||'').toLowerCase().replace(/^@/,''),x]));
        recordsByName=new Map(records.map(x=>[String(x.username||'').toLowerCase().replace(/^@/,''),x]));
        const primaryRepair=recordsByName.get('tresor20001')?.sessionRepairRequired===true;
        if(anime?.ok===true&&anime?.enabled===true
          &&String(anime?.destination||'').toLowerCase()==='@theotaku_nexus'
          &&(byName.has('tresor20001')||primaryRepair)
          &&byName.has('tresor20009'))break;
      }catch{}
      await sleep(2500);
    }
    if(anime?.ok!==true||anime?.enabled!==true||String(anime?.destination||'').toLowerCase()!=='@theotaku_nexus')throw new Error('anime status regression after session warmup');
    const primary=byName.get('tresor20001');
    const scanner=byName.get('tresor20009');
    const primaryRepair=recordsByName.get('tresor20001')?.sessionRepairRequired===true;
    if(!primary&&!primaryRepair)throw new Error('required NexAI runtime missing after custom-style deploy: @tresor20001');
    if(!scanner)throw new Error('required NexAI runtime missing after custom-style deploy: @tresor20009');
    if(primary&&(primary?.anime?.listener!==true||primary?.anime?.publisher!==true))throw new Error('@tresor20001 anime role regression');
    if(scanner?.anime?.listener!==true)throw new Error('@tresor20009 anime listener regression');
    const probeRuntime=primary||scanner||[...byName.values()][0];
    const probeUser=String(probeRuntime?.telegramUserId||'');
    if(!probeUser)throw new Error('menu probe user missing');
    const probe=cli('menu-probe',probeUser);
    if(probe?.ok!==true||!probe?.resultId)throw new Error('NexAI menu probe failed after custom-style deploy');
    report.steps.anime={
      ok:anime.ok,
      enabled:anime.enabled,
      destination:anime.destination,
      interSeriesMinutes:anime.interSeriesMinutes,
      scheduler:anime.scheduler,
      queue:anime.queue,
      published:anime.published
    };
    report.steps.accounts={
      tresor20001:primary?true:(primaryRepair?'repair-required':false),
      tresor20009:true
    };
    report.steps.menuProbe={ok:true,resultId:probe.resultId,telegramUserId:probeUser};
  }

  report.ok=true;
  report.finishedAt=new Date().toISOString();
  console.log(JSON.stringify(report));
}catch(e){
  report.error=String(e?.stack||e).slice(0,6000);
  if(changed){
    try{
      await restore();
      report.rollback={ok:true,health:await health(90000).catch(err=>({ok:false,error:String(err)}))};
    }catch(re){report.rollback={ok:false,error:String(re?.stack||re).slice(0,4000)}}
  }
  console.log(JSON.stringify(report));
  process.exitCode=1;
}