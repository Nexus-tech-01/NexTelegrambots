import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

const TARGET_SHA='9a22317ef637bb98be343daee6fb6c52609545f9';
const SHORT=TARGET_SHA.slice(0,10);
const MODE=process.argv[2]||'prepare';
const STATE='/var/lib/nex/state/nexai-independence-migration.json';
const CORE_APP='/opt/nex/apps/public/nexai';
const CORE_CURRENT=CORE_APP+'/current';
const ANIME_APP='/opt/nex/apps/internal-automation/nexanime';
const APK_APP='/opt/nex/apps/internal-automation/nexapk';
const DROPIN_DIR='/etc/systemd/system/nex-nexaccount.service.d';
const DROPIN=DROPIN_DIR+'/20-independent-workers.conf';
const ANIME_UNIT='/etc/systemd/system/nex-anime.service';
const APK_UNIT='/etc/systemd/system/nex-apk.service';
const ENV_FILE='/etc/nex/secrets/legacy-root.env';
const ANIME_SESS='/var/lib/nex/sessions/system/nexanime';
const APK_SESS='/var/lib/nex/sessions/system/nexapk';

function log(...a){console.log('[NexAI independence]',...a)}
function run(command,args=[],opts={}){
  const r=spawnSync(command,args,{encoding:'utf8',stdio:opts.capture?'pipe':'inherit',env:opts.env||process.env,cwd:opts.cwd||undefined,timeout:opts.timeout||180000});
  if(r.error)throw r.error;
  if(r.status!==0)throw new Error(command+' '+args.join(' ')+' failed '+r.status+' '+String(r.stderr||'').slice(-3000));
  return String(r.stdout||'');
}
function readMaybe(file){try{return fs.readFileSync(file,'utf8')}catch{return null}}
function linkTarget(file){try{return fs.realpathSync(file)}catch{return null}}
function atomicWrite(file,content,mode=0o644){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.tmp-'+process.pid;
  fs.writeFileSync(tmp,content,{mode});
  fs.renameSync(tmp,file);
}
function atomicLink(target,link){
  fs.mkdirSync(path.dirname(link),{recursive:true});
  const tmp=link+'.tmp-'+process.pid;
  try{fs.unlinkSync(tmp)}catch{}
  fs.symlinkSync(target,tmp);
  fs.renameSync(tmp,link);
}
function ensureOwnedDir(dir,mode='0750'){
  run('install',['-d','-o','nex-public','-g','nex','-m',mode,dir]);
}
function loadEnvFile(file){
  const env={...process.env};
  const raw=fs.readFileSync(file,'utf8');
  for(const rawLine of raw.split(/\r?\n/)){
    let line=rawLine.trim();
    if(!line||line.startsWith('#'))continue;
    if(line.startsWith('export '))line=line.slice(7).trim();
    const i=line.indexOf('=');
    if(i<=0)continue;
    const key=line.slice(0,i).trim();
    let value=line.slice(i+1).trim();
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    env[key]=value;
  }
  env.NEXACCOUNT_TELEGRAM_API_ID ||= env.NEXGROUP__TELEGRAM_API_ID||env.TELEGRAM_API_ID||'';
  env.NEXACCOUNT_TELEGRAM_API_HASH ||= env.NEXGROUP__TELEGRAM_API_HASH||env.TELEGRAM_API_HASH||'';
  return env;
}
async function download(rel,dest){
  const url='https://raw.githubusercontent.com/Nexus-tech-01/NexTelegrambots/'+TARGET_SHA+'/'+rel;
  const response=await fetch(url,{headers:{'user-agent':'NexControl-Migration/1.0'},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('download '+rel+' HTTP '+response.status);
  const text=await response.text();
  if(text.length<20)throw new Error('download '+rel+' unexpectedly short');
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.writeFileSync(dest,text,'utf8');
}
function copyRelease(source,dest){
  fs.mkdirSync(dest,{recursive:true});
  run('cp',['-a','--reflink=auto',source+'/.',dest],{timeout:300000});
}
function syntax(file){run('/usr/bin/node',['--check',file],{capture:true,timeout:30000})}
async function health(url,timeoutMs=5000){
  try{
    const r=await fetch(url,{signal:AbortSignal.timeout(timeoutMs)});
    const t=await r.text();
    let j={};try{j=JSON.parse(t)}catch{}
    return {http:r.status,ok:r.ok&&j?.ok===true,data:j};
  }catch(error){return {http:0,ok:false,error:String(error?.message||error)}}
}
async function waitHealth(url,ms=90000){
  const end=Date.now()+ms;
  let last=null;
  while(Date.now()<end){
    last=await health(url);
    if(last.ok)return last;
    await new Promise(r=>setTimeout(r,1500));
  }
  throw new Error('health timeout '+url+' '+JSON.stringify(last));
}
async function coreHealth(ms=90000){
  const end=Date.now()+ms;let last=[];
  while(Date.now()<end){
    last=[];
    for(const port of [18120,18110]){
      const h=await health('http://127.0.0.1:'+port+'/health');
      last.push({port,...h});
      if(h.ok&&h.data?.service==='nexaccount'&&Number(h.data?.runtimeCount||0)>0)return {port,...h};
    }
    await new Promise(r=>setTimeout(r,1500));
  }
  throw new Error('core health timeout '+JSON.stringify(last));
}
function journal(unit){
  try{return run('journalctl',['-u',unit,'--no-pager','-n','80'],{capture:true,timeout:30000}).slice(-12000)}
  catch{return ''}
}
function saveState(state){
  fs.mkdirSync(path.dirname(STATE),{recursive:true});
  atomicWrite(STATE,JSON.stringify(state,null,2),0o600);
}
function readState(){
  return JSON.parse(fs.readFileSync(STATE,'utf8'));
}

async function prepare(){
  if(typeof process.getuid==='function'&&process.getuid()!==0)throw new Error('migration requires root');
  const st=fs.statfsSync('/opt/nex');
  const available=Number(st.bavail)*Number(st.bsize);
  if(available<2*1024*1024*1024)throw new Error('less than 2 GiB available');
  const oldCore=linkTarget(CORE_CURRENT);
  if(!oldCore)throw new Error('current NexAI release not found');
  if(!fs.lstatSync(CORE_CURRENT).isSymbolicLink())throw new Error('NexAI current is not a symlink; refusing unsafe replacement');
  for(const rel of ['daemon.mjs','runtime.mjs','compat.mjs','config.mjs','scripts/derive-independent-session.mjs','automation/liteapks-relay.mjs']){
    if(!fs.existsSync(path.join(oldCore,rel)))throw new Error('live release missing '+rel);
  }

  const stamp=new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14);
  const coreRelease=CORE_APP+'/releases/independent-'+SHORT+'-'+stamp;
  const animeRelease=ANIME_APP+'/releases/independent-'+SHORT+'-'+stamp;
  const apkRelease=APK_APP+'/releases/independent-'+SHORT+'-'+stamp;

  log('copying immutable releases from',oldCore);
  copyRelease(oldCore,coreRelease);
  copyRelease(oldCore,animeRelease);
  copyRelease(oldCore,apkRelease);

  for(const rel of ['nexaccount/runtime.mjs','nexaccount/compat.mjs','nexaccount/bootstrap.mjs','nexaccount/daemon.mjs','nexaccount/workers/anime-worker.mjs','nexaccount/workers/liteapk-worker.mjs']){
    await download(rel,path.join(coreRelease,rel.replace(/^nexaccount\//,'')));
  }
  await download('nexaccount/workers/anime-worker.mjs',path.join(animeRelease,'workers/anime-worker.mjs'));
  await download('nexaccount/workers/liteapk-worker.mjs',path.join(apkRelease,'workers/liteapk-worker.mjs'));

  for(const file of [
    path.join(coreRelease,'runtime.mjs'),
    path.join(coreRelease,'compat.mjs'),
    path.join(coreRelease,'bootstrap.mjs'),
    path.join(coreRelease,'daemon.mjs'),
    path.join(coreRelease,'workers/anime-worker.mjs'),
    path.join(coreRelease,'workers/liteapk-worker.mjs'),
    path.join(animeRelease,'workers/anime-worker.mjs'),
    path.join(apkRelease,'workers/liteapk-worker.mjs')
  ])syntax(file);

  const runtime=fs.readFileSync(path.join(coreRelease,'runtime.mjs'),'utf8');
  const compat=fs.readFileSync(path.join(coreRelease,'compat.mjs'),'utf8');
  if(!runtime.includes('consumeGeneratedCommandOutput')||!runtime.includes('NEXACCOUNT_EMBEDDED_ANIME'))throw new Error('core release missing anti-loop/isolation guard');
  if(!compat.includes('✅ Diffusion terminée'))throw new Error('core release missing safe broadcast response');

  const state={
    targetSha:TARGET_SHA,preparedAt:new Date().toISOString(),oldCore,
    coreRelease,animeRelease,apkRelease,
    oldAnimeCurrent:linkTarget(ANIME_APP+'/current'),
    oldApkCurrent:linkTarget(APK_APP+'/current'),
    oldDropin:readMaybe(DROPIN),
    oldAnimeUnit:readMaybe(ANIME_UNIT),
    oldApkUnit:readMaybe(APK_UNIT)
  };
  saveState(state);
  log('PREPARED',JSON.stringify({targetSha:TARGET_SHA,oldCore,coreRelease,animeRelease,apkRelease,availableBytes:available}));
}

function unitAnime(release){
  return `[Unit]
Description=NEX NexAnime Independent Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nex-public
Group=nex
Slice=nex-public.slice
WorkingDirectory=${ANIME_APP}/current
EnvironmentFile=${ENV_FILE}
Environment=NODE_ENV=production
Environment=HOME=/var/lib/nex/runtime/internal-automation/nexanime
Environment=NEXANIME_WORKER_PORT=18130
Environment=NEXANIME_SESSION_DIR=${ANIME_SESS}
Environment=NEXANIME_PRIMARY_USERNAME=tresor20001
Environment=NEXANIME_SCANNER_USERNAMES=tresor20009,tresor20000
Environment=NEXANIME_TMP_DIR=/var/lib/nex/tmp/internal-automation/nexanime
Environment=NEXCANAL__WATCHER_ID_FILE=/var/lib/nex/state/nexcanal-watcher-id.txt
Environment=NEXUS_CUSTOM_EMOJI_CATALOG_PATH=/var/lib/nex/data/shared/custom-emoji-catalog/catalog.json
ExecStart=/usr/bin/node workers/anime-worker.mjs
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
KillSignal=SIGTERM
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
`;
}
function unitApk(release){
  return `[Unit]
Description=NEX NexAPK Independent Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nex-public
Group=nex
Slice=nex-public.slice
WorkingDirectory=${APK_APP}/current
EnvironmentFile=${ENV_FILE}
Environment=NODE_ENV=production
Environment=HOME=/var/lib/nex/runtime/internal-automation/nexapk
Environment=NEXAPK_WORKER_PORT=18131
Environment=NEXAPK_SCANNER_USERNAME=tresor20009
Environment=NEXAPK_SESSION_FILE=${APK_SESS}/tresor20009.session
Environment=NEXCANAL__WATCHER_ID_FILE=/var/lib/nex/state/nexcanal-watcher-id.txt
ExecStart=/usr/bin/node workers/liteapk-worker.mjs
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
KillSignal=SIGTERM
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
`;
}
function coreDropin(){
  return `[Service]
Environment=NEXACCOUNT_EMBEDDED_ANIME=false
Environment=NEXACCOUNT_EMBEDDED_LITEAPK=false
Environment=NEXANIME_WORKER_URL=http://127.0.0.1:18130
`;
}
function derive(release,username,outFile,env){
  log('deriving independent Telegram authorization for @'+username,path.basename(outFile));
  const r=spawnSync('/usr/bin/node',[path.join(release,'scripts/derive-independent-session.mjs'),'',username,outFile],{
    cwd:release,env,encoding:'utf8',timeout:120000
  });
  if(r.error)throw r.error;
  if(r.status!==0)throw new Error('derive @'+username+' failed: '+String(r.stderr||r.stdout||'').slice(-3000));
  if(!fs.existsSync(outFile)||fs.statSync(outFile).size<20)throw new Error('derived session missing for @'+username);
  run('chown',['nex-public:nex',outFile]);
  run('chmod',['0600',outFile]);
}
async function rollback(state,error){
  log('ROLLBACK because',String(error?.message||error));
  try{run('systemctl',['stop','nex-anime.service','nex-apk.service'])}catch{}
  try{
    if(state.oldCore)atomicLink(state.oldCore,CORE_CURRENT);
    if(state.oldAnimeCurrent)atomicLink(state.oldAnimeCurrent,ANIME_APP+'/current');
    if(state.oldApkCurrent)atomicLink(state.oldApkCurrent,APK_APP+'/current');
  }catch{}
  try{
    if(state.oldDropin===null)fs.rmSync(DROPIN,{force:true});else atomicWrite(DROPIN,state.oldDropin);
    if(state.oldAnimeUnit===null)fs.rmSync(ANIME_UNIT,{force:true});else atomicWrite(ANIME_UNIT,state.oldAnimeUnit);
    if(state.oldApkUnit===null)fs.rmSync(APK_UNIT,{force:true});else atomicWrite(APK_UNIT,state.oldApkUnit);
  }catch{}
  try{run('systemctl',['unmask','--runtime','nex-nexaccount.service'])}catch{}
  try{run('systemctl',['daemon-reload'])}catch{}
  try{run('systemctl',['start','nex-nexaccount.service'])}catch{}
  try{const h=await coreHealth(60000);log('ROLLBACK_CORE_HEALTHY port='+h.port)}catch(e){log('ROLLBACK_CORE_HEALTH_FAILED',String(e?.message||e))}
  throw error;
}

async function activate(){
  const state=readState();
  if(state.targetSha!==TARGET_SHA)throw new Error('prepared state target mismatch');
  const env=loadEnvFile(ENV_FILE);
  ensureOwnedDir('/var/lib/nex/state');
  ensureOwnedDir('/var/lib/nex/runtime/internal-automation/nexanime');
  ensureOwnedDir('/var/lib/nex/runtime/internal-automation/nexapk');
  ensureOwnedDir('/var/lib/nex/tmp/internal-automation/nexanime');
  ensureOwnedDir(ANIME_SESS);
  ensureOwnedDir(APK_SESS);

  try{
    log('stopping and runtime-masking monolithic NexAI for safe Telegram session derivation');
    run('systemctl',['mask','--runtime','--now','nex-nexaccount.service']);
    const active=spawnSync('systemctl',['is-active','nex-nexaccount.service'],{encoding:'utf8'});
    if(active.status===0)throw new Error('core service still active after runtime mask');

    derive(state.coreRelease,'tresor20001',ANIME_SESS+'/tresor20001.session',env);
    derive(state.coreRelease,'tresor20009',ANIME_SESS+'/tresor20009.session',env);
    derive(state.coreRelease,'tresor20000',ANIME_SESS+'/tresor20000.session',env);
    derive(state.coreRelease,'tresor20009',APK_SESS+'/tresor20009.session',env);

    atomicLink(state.animeRelease,ANIME_APP+'/current');
    atomicLink(state.apkRelease,APK_APP+'/current');
    atomicWrite(ANIME_UNIT,unitAnime(state.animeRelease));
    atomicWrite(APK_UNIT,unitApk(state.apkRelease));
    fs.mkdirSync(DROPIN_DIR,{recursive:true});
    atomicWrite(DROPIN,coreDropin());
    run('systemctl',['daemon-reload']);
    run('systemctl',['enable','nex-anime.service','nex-apk.service']);
    run('systemctl',['start','nex-anime.service']);
    try{await waitHealth('http://127.0.0.1:18130/health',120000)}
    catch(error){throw new Error(error.message+'\n'+journal('nex-anime.service'))}
    run('systemctl',['start','nex-apk.service']);
    try{await waitHealth('http://127.0.0.1:18131/health',90000)}
    catch(error){throw new Error(error.message+'\n'+journal('nex-apk.service'))}

    const animePid=run('systemctl',['show','nex-anime.service','--property=MainPID','--value'],{capture:true}).trim();
    const apkPid=run('systemctl',['show','nex-apk.service','--property=MainPID','--value'],{capture:true}).trim();

    atomicLink(state.coreRelease,CORE_CURRENT);
    run('systemctl',['unmask','--runtime','nex-nexaccount.service']);
    run('systemctl',['daemon-reload']);
    run('systemctl',['start','nex-nexaccount.service']);
    const core=await coreHealth(120000);

    const anime2=await waitHealth('http://127.0.0.1:18130/health',30000);
    const apk2=await waitHealth('http://127.0.0.1:18131/health',30000);
    const animePid2=run('systemctl',['show','nex-anime.service','--property=MainPID','--value'],{capture:true}).trim();
    const apkPid2=run('systemctl',['show','nex-apk.service','--property=MainPID','--value'],{capture:true}).trim();
    if(animePid!==animePid2||apkPid!==apkPid2)throw new Error('worker restarted during NexAI Core start; isolation check failed');

    const runtime=fs.readFileSync(path.join(state.coreRelease,'runtime.mjs'),'utf8');
    const compat=fs.readFileSync(path.join(state.coreRelease,'compat.mjs'),'utf8');
    if(!runtime.includes('consumeGeneratedCommandOutput')||!compat.includes('✅ Diffusion terminée'))throw new Error('anti-loop production verification failed');

    state.activatedAt=new Date().toISOString();
    state.corePort=core.port;
    state.animePid=animePid2;
    state.apkPid=apkPid2;
    state.status='active';
    saveState(state);
    log('ACTIVATED',JSON.stringify({
      core:{ok:true,port:core.port,runtimeCount:core.data?.runtimeCount},
      anime:{ok:anime2.ok,pid:animePid2,listeners:anime2.data?.listeners?.map(x=>x.username)},
      apk:{ok:apk2.ok,pid:apkPid2,username:apk2.data?.username},
      antiLoop:true,targetSha:TARGET_SHA
    }));
  }catch(error){
    await rollback(state,error);
  }
}

async function verify(){
  const state=readState();
  const core=await coreHealth(30000);
  const anime=await waitHealth('http://127.0.0.1:18130/health',30000);
  const apk=await waitHealth('http://127.0.0.1:18131/health',30000);
  const coreEnv=run('systemctl',['show','nex-nexaccount.service','--property=Environment','--value'],{capture:true});
  if(!coreEnv.includes('NEXACCOUNT_EMBEDDED_ANIME=false')||!coreEnv.includes('NEXACCOUNT_EMBEDDED_LITEAPK=false'))throw new Error('core isolation environment missing');
  const runtime=fs.readFileSync(path.join(fs.realpathSync(CORE_CURRENT),'runtime.mjs'),'utf8');
  const compat=fs.readFileSync(path.join(fs.realpathSync(CORE_CURRENT),'compat.mjs'),'utf8');
  if(!runtime.includes('consumeGeneratedCommandOutput')||!compat.includes('✅ Diffusion terminée'))throw new Error('anti-loop fix not active');
  log('VERIFIED',JSON.stringify({
    status:state.status||null,
    core:{port:core.port,runtimeCount:core.data?.runtimeCount,current:fs.realpathSync(CORE_CURRENT)},
    anime:{pid:run('systemctl',['show','nex-anime.service','--property=MainPID','--value'],{capture:true}).trim(),health:anime.data},
    apk:{pid:run('systemctl',['show','nex-apk.service','--property=MainPID','--value'],{capture:true}).trim(),health:apk.data},
    antiLoop:true,
    embeddedAnime:false,
    embeddedLiteApk:false
  }));
}

if(MODE==='prepare')await prepare();
else if(MODE==='activate')await activate();
else if(MODE==='verify')await verify();
else throw new Error('usage: migrate-nexai-independent-live.mjs prepare|activate|verify');
