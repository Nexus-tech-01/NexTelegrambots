import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync=promisify(execFile);
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const nowIso=()=>new Date().toISOString();
export const hash=value=>crypto.createHash('sha256').update(String(value??'')).digest('hex');
export const clip=(value,n=500)=>String(value??'').slice(0,n);

export async function ensureDir(fileOrDir,{isDir=false}={}){
  const dir=isDir?fileOrDir:path.dirname(fileOrDir);
  await fs.mkdir(dir,{recursive:true});
}

export async function readJson(file,fallback={}){
  try{return JSON.parse(await fs.readFile(file,'utf8'))}catch{return structuredClone(fallback)}
}

export async function writeJsonAtomic(file,value){
  await ensureDir(file);
  const tmp=file+'.'+process.pid+'.'+Date.now()+'.tmp';
  await fs.writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});
  await fs.rename(tmp,file);
}

export async function appendJsonl(file,value){
  await ensureDir(file);
  await fs.appendFile(file,JSON.stringify(value)+'\n',{mode:0o600});
}

export async function singletonLock(file,name='supervisor'){
  await ensureDir(file);
  try{
    const old=JSON.parse(await fs.readFile(file,'utf8'));
    const pid=Number(old?.pid||0);
    if(pid>1&&pid!==process.pid){
      try{process.kill(pid,0);return {ok:false,pid}}catch{}
    }
  }catch{}
  await fs.writeFile(file,JSON.stringify({pid:process.pid,name,startedAt:nowIso()},null,2),{mode:0o600});
  const release=()=>{
    try{
      const row=JSON.parse(fssync.readFileSync(file,'utf8'));
      if(Number(row?.pid)===process.pid)fssync.rmSync(file,{force:true});
    }catch{}
  };
  process.on('exit',release);
  return {ok:true,release};
}

export async function probeHttp(url,{timeoutMs=8000,headers={}}={}){
  const started=Date.now();
  try{
    const response=await fetch(url,{headers,signal:AbortSignal.timeout(timeoutMs),cache:'no-store'});
    const text=await response.text();
    let body=null;
    try{body=JSON.parse(text)}catch{body=text.slice(0,1000)}
    return {ok:response.ok,status:response.status,latencyMs:Date.now()-started,body};
  }catch(error){
    return {ok:false,status:0,latencyMs:Date.now()-started,error:clip(error?.message||error,400)};
  }
}

export async function run(command,args=[],{cwd,timeoutMs=120000,env={}}={}){
  try{
    const {stdout,stderr}=await execFileAsync(command,args,{cwd,timeout:timeoutMs,maxBuffer:8*1024*1024,env:{...process.env,...env}});
    return {ok:true,stdout:clip(stdout,12000),stderr:clip(stderr,12000)};
  }catch(error){
    return {ok:false,code:error?.code??null,signal:error?.signal??null,stdout:clip(error?.stdout,12000),stderr:clip(error?.stderr,12000),error:clip(error?.message||error,600)};
  }
}

export function fingerprint(kind,target,error=''){
  const normalized=String(error||'').replace(/\d{2,}/g,'#').replace(/0x[0-9a-f]+/ig,'0x#').slice(0,800);
  return hash([kind,target,normalized].join('|')).slice(0,24);
}

export function rememberIncident(state,{kind,target,severity='warning',message='',details=null,resolved=false}){
  state.incidents=state.incidents||{};
  const id=fingerprint(kind,target,message);
  const row=state.incidents[id]||{id,kind,target,firstSeenAt:nowIso(),count:0};
  row.count=Number(row.count||0)+1;
  row.lastSeenAt=nowIso();
  row.severity=severity;
  row.message=clip(message,1000);
  row.details=details;
  row.resolved=resolved===true;
  if(resolved)row.resolvedAt=nowIso();
  state.incidents[id]=row;
  state.incidentOrder=[id,...(state.incidentOrder||[]).filter(x=>x!==id)].slice(0,300);
  const repeat=row.count;
  state.learnedRules=state.learnedRules||{};
  if(repeat>=3){
    state.learnedRules[id]={
      fingerprint:id,kind,target,
      promotedAt:state.learnedRules[id]?.promotedAt||nowIso(),
      occurrences:repeat,
      priority:repeat>=10?'critical':repeat>=5?'high':'elevated',
      suggestedProbeMultiplier:repeat>=10?0.25:repeat>=5?0.5:0.75
    };
  }
  return row;
}

export async function requestRepair({root='.',target,reason,service='',restartHook='.nexcontrol/control/restart.json',allowSystemd=true}){
  const safeService=/^[a-zA-Z0-9_.@-]+\.service$/.test(service)?service:'';
  if(allowSystemd&&safeService&&process.platform==='linux'){
    const result=await run('/bin/systemctl',['restart',safeService],{timeoutMs:30000});
    if(result.ok)return {ok:true,method:'systemd',service:safeService};
  }
  const hook=path.resolve(root,restartHook);
  await writeJsonAtomic(hook,{target:target||service||'all',reason,requestedAt:nowIso(),nonce:crypto.randomUUID()});
  return {ok:true,method:'restart-hook',hook};
}

export function parseTargets(raw,defaults=[]){
  if(!raw)return defaults;
  try{
    const x=JSON.parse(raw);
    return Array.isArray(x)?x:defaults;
  }catch{return defaults}
}

export async function listProcessMatches(patterns=[]){
  if(process.platform!=='linux')return [];
  let ids=[];
  try{ids=(await fs.readdir('/proc')).filter(x=>/^\d+$/.test(x)).map(Number)}catch{return []}
  const rows=[];
  for(const pid of ids){
    try{
      const cmd=(await fs.readFile('/proc/'+pid+'/cmdline')).toString('utf8').split('\0').filter(Boolean).join(' ');
      if(patterns.some(p=>cmd.includes(p)))rows.push({pid,cmd});
    }catch{}
  }
  return rows;
}
