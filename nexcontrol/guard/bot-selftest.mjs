import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync=promisify(execFile);
const ROOT=path.resolve(process.env.NEX_ROOT||(fssync.existsSync('/opt/nex/current')?'/opt/nex/current':path.resolve(process.cwd(),'../..')));
const TIMEOUT=Math.max(30_000,Number(process.env.NEXGUARD_BOT_TEST_TIMEOUT_MS||5*60*1000));
const MAX_FILES=Math.max(20,Number(process.env.NEXGUARD_BOT_TEST_MAX_FILES||250));
const DEFAULT_COMPONENTS=[
  ['nexaccount','nexaccount'],
  ['nexgroup','bots/nexgroup'],
  ['nexcanal','bots/nexcanal'],
  ['nexgame','bots/nexgame'],
  ['nexdownloader','bots/nexdownloader'],
  ['nexstick','bots/nexstick'],
  ['nexwhisper','bots/nexwhisper'],
  ['stacy','bots/stacy'],
  ['whatsapp-publisher','whatsapp-publisher'],
  ['watchers','watchers']
].map(([name,rel])=>({name,rel}));

function components(){
  const raw=String(process.env.NEXGUARD_COMPONENTS_JSON||'').trim();
  if(!raw)return DEFAULT_COMPONENTS;
  try{
    const rows=JSON.parse(raw);
    return Array.isArray(rows)?rows.map(x=>typeof x==='string'?{name:x,rel:x}:x).filter(x=>x?.name&&x?.rel):DEFAULT_COMPONENTS;
  }catch{return DEFAULT_COMPONENTS}
}

async function run(file,args,{cwd=ROOT,timeout=TIMEOUT,env={}}={}){
  const started=Date.now();
  try{
    const {stdout,stderr}=await execFileAsync(file,args,{cwd,timeout,maxBuffer:8*1024*1024,env:{...process.env,...env}});
    return {ok:true,durationMs:Date.now()-started,stdout:String(stdout||'').slice(-3000),stderr:String(stderr||'').slice(-2000)};
  }catch(error){
    return {ok:false,durationMs:Date.now()-started,error:String(error?.message||error).slice(0,1000),stdout:String(error?.stdout||'').slice(-3000),stderr:String(error?.stderr||'').slice(-3000)};
  }
}

async function listSourceFiles(dir){
  const out=[];
  const ignored=new Set(['node_modules','.git','dist','build','.next','coverage','.cache','tmp','temp']);
  async function walk(cur){
    if(out.length>=MAX_FILES)return;
    let entries=[];try{entries=await fs.readdir(cur,{withFileTypes:true})}catch{return}
    for(const e of entries){
      if(out.length>=MAX_FILES)break;
      if(ignored.has(e.name))continue;
      const full=path.join(cur,e.name);
      if(e.isDirectory())await walk(full);
      else if(e.isFile()&&/.(?:mjs|cjs|js|py)$/i.test(e.name))out.push(full);
    }
  }
  await walk(dir);
  return out;
}

async function checkNodeSyntax(files){
  const failures=[];let checked=0;
  for(const file of files.filter(x=>/.(?:mjs|cjs|js)$/i.test(x))){
    const r=await run(process.execPath,['--check',file],{cwd:ROOT,timeout:30_000});
    checked++;
    if(!r.ok){failures.push({file:path.relative(ROOT,file),error:r.stderr||r.error});if(failures.length>=10)break}
  }
  return {ok:failures.length===0,checked,failures};
}

async function checkPythonSyntax(dir,files){
  if(!files.some(x=>/.py$/i.test(x)))return {ok:true,checked:0,skipped:true};
  const r=await run('/usr/bin/python3',['-m','compileall','-q',dir],{cwd:dir,timeout:TIMEOUT});
  return {ok:r.ok,checked:files.filter(x=>/.py$/i.test(x)).length,error:r.ok?'':(r.stderr||r.error)};
}

async function checkComponent(def){
  const dir=path.resolve(ROOT,String(def.rel));
  try{await fs.access(dir)}catch{return {name:def.name,rel:def.rel,present:false,ok:true,skipped:'missing'}}
  const pkgPath=path.join(dir,'package.json');
  let pkg=null;try{pkg=JSON.parse(await fs.readFile(pkgPath,'utf8'))}catch{}
  if(pkg?.scripts?.check){
    const r=await run('/usr/bin/npm',['run','check'],{cwd:dir,timeout:Math.max(TIMEOUT,8*60*1000)});
    return {name:def.name,rel:def.rel,present:true,ok:r.ok,mode:'npm-check',durationMs:r.durationMs,error:r.ok?'':(r.stderr||r.error),output:r.stdout};
  }
  const files=await listSourceFiles(dir);
  const [node,python]=await Promise.all([checkNodeSyntax(files),checkPythonSyntax(dir,files)]);
  return {name:def.name,rel:def.rel,present:true,ok:node.ok&&python.ok,mode:'syntax',node,python,fileCount:files.length};
}

async function nexAccountRuntimeSmoke(){
  const enabled=/^(?:1|true|yes|on)$/i.test(String(process.env.NEXGUARD_NEXACCOUNT_SMOKE||''));
  if(!enabled)return {ok:true,skipped:'disabled'};
  const key=String(process.env.NEXACCOUNT_CONTROL_KEY||process.env.NEXCONTROL_FLEET_KEY||'').trim();
  const telegramUserId=String(process.env.NEXGUARD_TEST_TELEGRAM_USER_ID||process.env.NEXAI_OWNER_TELEGRAM_ID||process.env.NEXUS_OWNER_TELEGRAM_ID||'').trim();
  if(!key||!telegramUserId)return {ok:true,skipped:'missing-key-or-runtime-id'};
  const base=String(process.env.NEXGUARD_NEXACCOUNT_URL||'http://127.0.0.1:'+(process.env.NEXACCOUNT_PORT||3491)).replace(//$/,'');
  const call=async(pathname,payload)=>{
    try{
      const response=await fetch(base+pathname,{method:'POST',headers:{'content-type':'application/json','x-nexaccount-key':key},body:JSON.stringify(payload),signal:AbortSignal.timeout(30_000)});
      const body=await response.json().catch(()=>({}));
      return {ok:response.ok&&body?.ok!==false,status:response.status,body};
    }catch(error){return {ok:false,error:String(error?.message||error)}}
  };
  const results=[];
  results.push({name:'menu',...await call('/diagnostics/menu',{telegramUserId,peer:'me'})});
  for(const text of ['.ping','.alive','.account'])results.push({name:text,...await call('/diagnostics/command',{telegramUserId,text,peer:'me'})});
  return {ok:results.every(x=>x.ok),results};
}

const started=Date.now();
const results=[];
for(const def of components())results.push(await checkComponent(def));
const runtimeSmoke=await nexAccountRuntimeSmoke();
const failures=results.filter(x=>x.present&&!x.ok);
const summary={
  ok:failures.length===0&&runtimeSmoke.ok,
  startedAt:new Date(started).toISOString(),
  finishedAt:new Date().toISOString(),
  durationMs:Date.now()-started,
  root:ROOT,
  components:results,
  runtimeSmoke,
  failures:failures.map(x=>x.name)
};
console.log(JSON.stringify(summary));
if(!summary.ok)process.exitCode=1;
