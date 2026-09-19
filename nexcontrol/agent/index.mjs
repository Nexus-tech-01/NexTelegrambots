import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const cfgPath=path.resolve(process.env.NEXCONTROL_AGENT_CONFIG||'./nexcontrol/agent/agent.config.json');
const cfg=JSON.parse(await fs.readFile(cfgPath,'utf8'));
const KEY=String(process.env.NEXCONTROL_AGENT_KEY||process.env.NEXCONTROL_FLEET_KEY||'').trim();
if(!KEY)throw new Error('NEXCONTROL_AGENT_KEY/NEXCONTROL_FLEET_KEY missing');
const BUILTIN_FALLBACK='https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexcontrol';
const cleanUrl=value=>String(value||'').trim().replace(/\/$/,'');
const splitUrls=value=>String(value||'').split(/[\s,;]+/).map(cleanUrl).filter(Boolean);
const configuredUrls=[
  ...splitUrls(process.env.NEXCONTROL_URLS),
  cleanUrl(process.env.NEXCONTROL_URL),
  cleanUrl(process.env.NEXCONTROL_BASE_URL),
  ...(Array.isArray(cfg.controlUrls)?cfg.controlUrls.map(cleanUrl):[]),
  cleanUrl(cfg.controlUrl),
  BUILTIN_FALLBACK,
].filter(Boolean);
const CONTROL_URLS=[...new Set(configuredUrls)].filter(url=>{try{return new URL(url).protocol==='https:'}catch{return false}});
if(!CONTROL_URLS.length)throw new Error('NexControl URL missing');
let activeControlIndex=0;
let lastControlSwitchAt=0;
const CONTROL_REPROBE_MS=Math.max(30000,Number(process.env.NEXCONTROL_PRIMARY_REPROBE_MS||cfg.primaryReprobeMs||300000));
const SLUG=String(process.env.NEXCONTROL_AGENT_SLUG||cfg.agentSlug||os.hostname()).toLowerCase();
const NAME=process.env.NEXCONTROL_AGENT_NAME||cfg.agentName||SLUG;
const POLL_MS=Math.max(1000,Number(cfg.pollMs||2500));
const HEARTBEAT_MS=Math.max(10000,Number(cfg.heartbeatMs||30000));
const MAX_READ=Math.min(8*1024*1024,Math.max(4096,Number(cfg.maxReadBytes||1024*1024)));
const MAX_SEARCH_FILES=Math.min(10000,Math.max(10,Number(cfg.maxSearchFiles||2000)));
const BACKUP_DIR=path.resolve(cfg.backupDir||'.nexcontrol/backups');
await fs.mkdir(BACKUP_DIR,{recursive:true});

const roots=Object.fromEntries(Object.entries(cfg.roots||{}).map(([k,v])=>[k,path.resolve(String(v))]));
if(!Object.keys(roots).length)throw new Error('No roots configured');

async function requestControl(base,endpoint,body={}){
  const r=await fetch(base+endpoint,{method:'POST',headers:{'content-type':'application/json','x-nexcontrol-agent':SLUG,'x-nexcontrol-agent-key':KEY,'x-nexcontrol-path':endpoint},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if(!r.ok){const error=new Error(`${new URL(base).host}${endpoint}: HTTP ${r.status} ${data?.error||text}`);error.status=r.status;throw error}
  return data;
}
async function api(endpoint,body={}){
  if(activeControlIndex>0&&Date.now()-lastControlSwitchAt>=CONTROL_REPROBE_MS)activeControlIndex=0;
  const order=[];
  for(let offset=0;offset<CONTROL_URLS.length;offset++)order.push((activeControlIndex+offset)%CONTROL_URLS.length);
  const failures=[];
  for(const index of order){
    const base=CONTROL_URLS[index];
    try{
      const data=await requestControl(base,endpoint,body);
      if(index!==activeControlIndex){
        activeControlIndex=index;lastControlSwitchAt=Date.now();
        console.warn('[NexControlAgent] control plane switched to',new URL(base).host);
      }
      return data;
    }catch(error){failures.push(`${new URL(base).host}: ${String(error?.message||error).slice(0,300)}`)}
  }
  throw new Error(`${endpoint}: all NexControl endpoints failed — ${failures.join(' | ')}`);
}
function rootBase(root){const base=roots[root];if(!base)throw new Error(`Unknown root: ${root}`);return base}
function lexical(root,rel='.'){
  const base=rootBase(root),out=path.resolve(base,String(rel||'.')),r=path.relative(base,out);
  if(r.startsWith('..')||path.isAbsolute(r))throw new Error('Path escapes root');
  return{base,out,rel:r||'.'};
}
async function safe(root,rel='.',allowMissingLeaf=false){
  const {base,out}=lexical(root,rel),baseReal=await fs.realpath(base),parts=path.relative(base,out).split(path.sep).filter(Boolean);
  let cur=base;
  for(let i=0;i<parts.length;i++){
    cur=path.join(cur,parts[i]);
    try{const st=await fs.lstat(cur);if(st.isSymbolicLink())throw new Error('Symlink paths are not allowed')}
    catch(e){if(e?.code==='ENOENT'&&allowMissingLeaf)continue;throw e}
  }
  if(path.resolve(out)===path.resolve(base))return{base,out};
  const parent=await fs.realpath(path.dirname(out)).catch(()=>baseReal),r=path.relative(baseReal,parent);
  if(r.startsWith('..')||path.isAbsolute(r))throw new Error('Real path escapes root');
  return{base,out};
}
async function backup(root,rel,action='change'){
  const {out}=await safe(root,rel),data=await fs.readFile(out),id=`${Date.now()}-${crypto.randomBytes(5).toString('hex')}`,dir=path.join(BACKUP_DIR,id);
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'content.bin'),data);
  await fs.writeFile(path.join(dir,'meta.json'),JSON.stringify({root,rel,action,sha256:sha(data),createdAt:new Date().toISOString()},null,2));
  return{backupId:id,beforeSha:sha(data),bytes:data.length};
}
async function listDir(p){
  const rel=p.path||'.',{out}=await safe(p.root,rel),ents=await fs.readdir(out,{withFileTypes:true}),items=[];
  for(const e of ents.slice(0,2000)){const st=await fs.lstat(path.join(out,e.name));items.push({name:e.name,type:e.isDirectory()?'dir':e.isFile()?'file':e.isSymbolicLink()?'symlink':'other',size:st.size,mtime:st.mtime.toISOString()})}
  items.sort((a,b)=>(a.type==='dir'?0:1)-(b.type==='dir'?0:1)||a.name.localeCompare(b.name));return{root:p.root,path:rel,items};
}
async function readFile(p){
  const {out}=await safe(p.root,p.path),st=await fs.stat(out);if(!st.isFile())throw new Error('Not a file');if(st.size>MAX_READ)throw new Error(`File too large (${st.size})`);
  const buf=await fs.readFile(out);if(buf.includes(0))throw new Error('Binary file');const lines=buf.toString('utf8').split(/\r?\n/),start=Math.max(1,Number(p.startLine||1)),end=Math.min(lines.length,Number(p.endLine||lines.length));
  return{root:p.root,path:p.path,sha256:sha(buf),bytes:buf.length,totalLines:lines.length,startLine:start,endLine:end,content:lines.slice(start-1,end).join('\n')};
}
async function searchFiles(p){
  const needle=String(p.query||'');if(!needle)throw new Error('query required');const base=rootBase(p.root),start=lexical(p.root,p.path||'.').out,out=[];let visited=0;
  const ignored=new Set(['node_modules','.git','.nexcontrol','dist','build','.next']);const maxResults=Math.min(200,Math.max(1,Number(p.maxResults||100))),want=p.caseSensitive?needle:needle.toLowerCase();
  async function walk(dir){
    if(visited>=MAX_SEARCH_FILES||out.length>=maxResults)return;
    for(const e of await fs.readdir(dir,{withFileTypes:true})){
      if(ignored.has(e.name))continue;const full=path.join(dir,e.name);
      if(e.isDirectory()){await walk(full);if(visited>=MAX_SEARCH_FILES||out.length>=maxResults)return;continue}if(!e.isFile())continue;visited++;
      let st,buf;try{st=await fs.stat(full);if(st.size>MAX_READ)continue;buf=await fs.readFile(full)}catch{continue}if(buf.includes(0))continue;
      const lines=buf.toString('utf8').split(/\r?\n/);for(let i=0;i<lines.length;i++){const hay=p.caseSensitive?lines[i]:lines[i].toLowerCase();if(hay.includes(want)){out.push({path:path.relative(base,full),line:i+1,text:lines[i].slice(0,500)});if(out.length>=maxResults)return}}
    }
  }
  await walk(start);return{root:p.root,path:p.path||'.',query:needle,visited,matches:out};
}
async function writeFile(p){
  const {out}=await safe(p.root,p.path,true),exists=fssync.existsSync(out);let beforeSha=null,backupId=null;
  if(exists){const old=await fs.readFile(out);beforeSha=sha(old);if(p.expectedSha&&p.expectedSha!==beforeSha)throw new Error(`SHA mismatch: expected ${p.expectedSha}, actual ${beforeSha}`);({backupId}=await backup(p.root,p.path,'write'))}else await fs.mkdir(path.dirname(out),{recursive:true});
  const content=Buffer.from(String(p.content??''),'utf8');if(content.length>MAX_READ*4)throw new Error('Write payload too large');const tmp=`${out}.nxc-${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp,content,{mode:0o600});await fs.rename(tmp,out);return{root:p.root,path:p.path,created:!exists,beforeSha,afterSha:sha(content),backupId,bytes:content.length};
}
async function copyPath(p){
  const a=await safe(p.root,p.path),b=await safe(p.root,p.toPath,true),st=await fs.lstat(a.out);
  if(fssync.existsSync(b.out)&&!p.overwrite)throw new Error('Destination exists');
  if(fssync.existsSync(b.out)&&p.overwrite){
    const bst=await fs.lstat(b.out);
    if(bst.isFile())await backup(p.root,p.toPath,'pre-copy-overwrite');
    await fs.rm(b.out,{recursive:true,force:true});
  }
  await fs.mkdir(path.dirname(b.out),{recursive:true});
  if(st.isDirectory())await fs.cp(a.out,b.out,{recursive:true,errorOnExist:!p.overwrite,force:!!p.overwrite});
  else await fs.copyFile(a.out,b.out);
  return{root:p.root,path:p.path,toPath:p.toPath,copied:st.isDirectory()?'dir':'file'};
}
async function diskUsage(p={}){
  const target=p.root?rootBase(p.root):process.cwd();
  const st=await fs.statfs(target),block=Number(st.bsize||4096);
  return{
    target,
    blockSize:block,
    blocks:Number(st.blocks),
    freeBlocks:Number(st.bfree),
    availableBlocks:Number(st.bavail),
    bytesTotal:Number(st.blocks)*block,
    bytesFree:Number(st.bfree)*block,
    bytesAvailable:Number(st.bavail)*block
  };
}
async function envKeys(){
  const secretLike=/token|secret|password|passwd|key|uri|dsn|credential|cookie|session|auth/i;
  const keys=Object.keys(process.env).sort();
  return{count:keys.length,keys:keys.map(name=>({name,sensitive:secretLike.test(name)}))};
}


async function envCheck(p={}){
  const names=Array.isArray(p.names)?p.names.slice(0,200).map(x=>String(x).trim()).filter(Boolean):[];
  const items=names.map(name=>({name,present:Object.prototype.hasOwnProperty.call(process.env,name)&&String(process.env[name]||'').length>0}));
  return{count:items.length,present:items.filter(x=>x.present).length,missing:items.filter(x=>!x.present).map(x=>x.name),items};
}
async function fsTree(p={}){
  const base=rootBase(p.root),start=lexical(p.root,p.path||'.').out,maxDepth=Math.min(8,Math.max(0,Number(p.maxDepth??3))),maxItems=Math.min(5000,Math.max(10,Number(p.maxItems||1000))),items=[];
  async function walk(dir,depth){
    if(depth>maxDepth||items.length>=maxItems)return;
    for(const e of await fs.readdir(dir,{withFileTypes:true})){
      if(items.length>=maxItems)break;
      if(['node_modules','.git','.nexcontrol'].includes(e.name)&&p.includeHeavy!==true)continue;
      const full=path.join(dir,e.name),st=await fs.lstat(full);
      items.push({path:path.relative(base,full),type:e.isDirectory()?'dir':e.isFile()?'file':e.isSymbolicLink()?'symlink':'other',size:st.size,mtime:st.mtime.toISOString()});
      if(e.isDirectory())await walk(full,depth+1);
    }
  }
  await walk(start,0);return{root:p.root,path:p.path||'.',items,truncated:items.length>=maxItems};
}
async function compareFiles(p){
  const a=await readFile({root:p.root,path:p.pathA,startLine:1,endLine:Number.MAX_SAFE_INTEGER});
  const b=await readFile({root:p.root,path:p.pathB,startLine:1,endLine:Number.MAX_SAFE_INTEGER});
  return{root:p.root,pathA:p.pathA,pathB:p.pathB,same:a.sha256===b.sha256,shaA:a.sha256,shaB:b.sha256,bytesA:a.bytes,bytesB:b.bytes};
}
async function searchLogs(p={}){
  const f=cfg.logFiles?.[p.log];if(!f)throw new Error('Unknown log');
  const query=String(p.query||'');if(!query)throw new Error('query required');
  const out=path.resolve(String(f)),st=await fs.stat(out),bytes=Math.min(st.size,Math.max(4096,Math.min(2*1024*1024,Number(p.bytes||512000)))),h=await fs.open(out,'r'),buf=Buffer.alloc(bytes);
  await h.read(buf,0,bytes,Math.max(0,st.size-bytes));await h.close();
  const lines=buf.toString('utf8').split(/\r?\n/),want=p.caseSensitive?query:query.toLowerCase(),matches=[];
  for(let i=0;i<lines.length&&matches.length<Math.min(500,Math.max(1,Number(p.maxResults||100)));i++){const hay=p.caseSensitive?lines[i]:lines[i].toLowerCase();if(hay.includes(want))matches.push({line:i+1,text:lines[i].slice(0,2000)})}
  return{log:p.log,query,matches,scannedBytes:bytes};
}
async function httpCheck(p={}){
  const url=String(p.url||'');const u=new URL(url);if(!['http:','https:'].includes(u.protocol))throw new Error('Only http/https allowed');
  const started=Date.now(),r=await fetch(url,{method:String(p.method||'GET').toUpperCase(),redirect:'manual',signal:AbortSignal.timeout(Math.min(30000,Math.max(1000,Number(p.timeoutMs||10000))))});
  const body=await r.text().catch(()=> '');
  return{url,status:r.status,ok:r.ok,latencyMs:Date.now()-started,contentType:r.headers.get('content-type')||'',bodyPreview:body.slice(0,Math.min(2000,Math.max(0,Number(p.previewBytes||500))))};
}
async function gitLog(p={}){
  const cwd=rootBase(p.root),n=Math.min(100,Math.max(1,Number(p.limit||20)));
  return runProcess('git',['log','--oneline','--decorate','-'+n],{cwd,timeoutMs:p.timeoutMs||30000,maxOutput:200000});
}
async function gitBranches(p={}){
  const cwd=rootBase(p.root);
  return runProcess('git',['branch','--all','--no-color'],{cwd,timeoutMs:p.timeoutMs||30000,maxOutput:200000});
}
async function gitCheckout(p={}){
  const cwd=rootBase(p.root),ref=gitName(p.ref,'ref');
  const dirty=await runProcess('git',['status','--porcelain'],{cwd,timeoutMs:30000});
  if(dirty.stdout.trim()&&p.allowDirty!==true)throw new Error('Working tree is dirty');
  return runProcess('git',['checkout',ref],{cwd,timeoutMs:p.timeoutMs||60000,maxOutput:300000});
}
async function gitCommit(p={}){
  const cwd=rootBase(p.root),message=String(p.message||'').trim().slice(0,300);if(!message)throw new Error('commit message required');
  const paths=Array.isArray(p.paths)?p.paths.slice(0,100):[];
  if(paths.length)for(const rel of paths)lexical(p.root,rel);
  const add=await runProcess('git',paths.length?['add','--',...paths]:['add','-A'],{cwd,timeoutMs:60000,maxOutput:200000});if(!add.ok)return{stage:'add',add,ok:false};
  const commit=await runProcess('git',['commit','-m',message],{cwd,timeoutMs:p.timeoutMs||60000,maxOutput:300000});
  return{stage:'commit',add,commit,ok:commit.ok};
}
async function backupSnapshot(p={}){
  const root=String(p.root||''),base=rootBase(root),paths=Array.isArray(p.paths)&&p.paths.length?p.paths.slice(0,100):['.'];
  const id='snapshot-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'),dir=path.join(BACKUP_DIR,id);await fs.mkdir(dir,{recursive:true});
  const copied=[];
  for(const rel of paths){
    const {out}=await safe(root,rel),dst=path.join(dir,rel==='.'?'root':rel),st=await fs.lstat(out);
    await fs.mkdir(path.dirname(dst),{recursive:true});
    if(st.isDirectory())await fs.cp(out,dst,{recursive:true,filter:(src)=>!/(^|[\\/])(node_modules|\.git|\.nexcontrol)([\\/]|$)/.test(src)});
    else await fs.copyFile(out,dst);
    copied.push(rel);
  }
  await fs.writeFile(path.join(dir,'snapshot.json'),JSON.stringify({id,root,paths:copied,createdAt:new Date().toISOString()},null,2));
  return{snapshotId:id,root,paths:copied,dir};
}
async function deployPipeline(p={}){
  const root=String(p.root||'');rootBase(root);
  const files=Array.isArray(p.files)?p.files.slice(0,80):[];if(!files.length)throw new Error('files required');
  const writes=[],rollbacks=[],checks=[];
  try{
    for(const f of files){
      const r=await writeFile({root,path:String(f.path||''),content:String(f.content??''),expectedSha:f.expectedSha||undefined});
      writes.push(r);
    }
    for(const c of (Array.isArray(p.checks)?p.checks.slice(0,30):[])){
      const r=await runCheck({root,check:String(c.check||''),file:c.file?String(c.file):undefined,timeoutMs:c.timeoutMs});
      checks.push(r);if(!r.ok)throw new Error('check failed: '+String(c.check||'unknown'));
    }
    const verified=[];
    for(const w of writes){const h=await hashFile({root,path:w.path});verified.push({path:w.path,sha256:h.sha256,expected:w.afterSha,match:h.sha256===w.afterSha});if(h.sha256!==w.afterSha)throw new Error('post-write hash mismatch: '+w.path)}
    const restartResult=p.restartTarget?await restart({target:String(p.restartTarget),reason:String(p.reason||'NexControl deploy.pipeline')}):null;
    return{ok:true,root,writes,checks,verified,restart:restartResult,completedAt:new Date().toISOString()};
  }catch(error){
    for(const w of [...writes].reverse()){
      try{
        if(w.created){const {out}=await safe(root,w.path);await fs.rm(out,{force:true});rollbacks.push({path:w.path,removed:true});}
        else if(w.backupId)rollbacks.push(await rollback({backupId:w.backupId}));
      }catch(e){rollbacks.push({path:w.path,error:String(e?.message||e)})}
    }
    throw new Error('deploy.pipeline failed and rollback attempted: '+JSON.stringify({cause:String(error?.message||error),writes:writes.map(x=>({path:x.path,backupId:x.backupId,created:x.created})),checks:checks.map(x=>({check:x.check,ok:x.ok,code:x.code})),rollbacks}).slice(0,15000));
  }
}

function literalCount(source,needle){
  if(!needle)return 0;let count=0,pos=0;
  while((pos=source.indexOf(needle,pos))!==-1){count++;pos+=needle.length}
  return count;
}
async function deployPatchPipeline(p={}){
  const root=String(p.root||'');rootBase(root);
  const specs=Array.isArray(p.patches)?p.patches.slice(0,80):[];
  const creates=Array.isArray(p.createFiles)?p.createFiles.slice(0,40):[];
  if(!specs.length&&!creates.length)throw new Error('patches or createFiles required');
  const changed=[],checks=[],rollbacks=[];
  try{
    for(const spec of specs){
      const rel=String(spec.path||''),{out}=await safe(root,rel),old=await fs.readFile(out);
      if(old.includes(0))throw new Error('Binary patch target: '+rel);
      const beforeSha=sha(old);
      if(spec.expectedSha&&String(spec.expectedSha)!==beforeSha)throw new Error('SHA mismatch for '+rel+': expected '+spec.expectedSha+', actual '+beforeSha);
      let next=old.toString('utf8');
      const reps=Array.isArray(spec.replacements)?spec.replacements.slice(0,80):[];
      if(!reps.length)throw new Error('replacements required for '+rel);
      for(const r of reps){
        const find=String(r.find??''),replace=String(r.replace??'');
        if(!find||find.length>200000||replace.length>300000)throw new Error('invalid replacement for '+rel);
        const count=literalCount(next,find);
        if(r.expectedCount!=null&&count!==Number(r.expectedCount))throw new Error('replacement count mismatch for '+rel+': expected '+r.expectedCount+', actual '+count);
        if(r.expectedCount==null&&count<1)throw new Error('replacement not found for '+rel);
        next=r.all===true?next.split(find).join(replace):next.replace(find,replace);
      }
      const b=await backup(root,rel,'patch'),st=await fs.stat(out),buf=Buffer.from(next,'utf8'),tmp=out+'.nxc-patch-'+crypto.randomBytes(4).toString('hex')+'.tmp';
      await fs.writeFile(tmp,buf,{mode:st.mode&0o777});await fs.rename(tmp,out);
      const afterSha=sha(buf);
      if(spec.expectedAfterSha&&String(spec.expectedAfterSha)!==afterSha)throw new Error('post-patch SHA mismatch for '+rel+': expected '+spec.expectedAfterSha+', actual '+afterSha);
      changed.push({root,path:rel,beforeSha,afterSha,backupId:b.backupId,created:false,bytes:buf.length});
    }
    for(const spec of creates){
      const rel=String(spec.path||''),r=await writeFile({root,path:rel,content:String(spec.content??''),expectedSha:spec.expectedSha||undefined});
      if(spec.expectedAfterSha&&r.afterSha!==String(spec.expectedAfterSha))throw new Error('created file SHA mismatch for '+rel);
      changed.push(r);
    }
    for(const c of (Array.isArray(p.checks)?p.checks.slice(0,30):[])){
      const r=await runCheck({root,check:String(c.check||''),file:c.file?String(c.file):undefined,timeoutMs:c.timeoutMs});
      checks.push(r);if(!r.ok)throw new Error('check failed: '+String(c.check||'unknown'));
    }
    const verified=[];
    for(const w of changed){
      const h=await hashFile({root,path:w.path});
      verified.push({path:w.path,sha256:h.sha256,expected:w.afterSha,match:h.sha256===w.afterSha});
      if(h.sha256!==w.afterSha)throw new Error('post-patch verify mismatch: '+w.path);
    }
    const restartResult=p.restartTarget?await restart({target:String(p.restartTarget),reason:String(p.reason||'NexControl deploy.patchPipeline')}):null;
    return{ok:true,root,changed,checks:checks.map(x=>({check:x.check,ok:x.ok,code:x.code,stdout:x.stdout?.slice(-5000),stderr:x.stderr?.slice(-5000)})),verified,restart:restartResult,completedAt:new Date().toISOString()};
  }catch(error){
    for(const w of [...changed].reverse()){
      try{
        if(w.created){const {out}=await safe(root,w.path);await fs.rm(out,{force:true});rollbacks.push({path:w.path,removed:true});}
        else if(w.backupId)rollbacks.push(await rollback({backupId:w.backupId}));
      }catch(e){rollbacks.push({path:w.path,error:String(e?.message||e)})}
    }
    throw new Error('deploy.patchPipeline failed and rollback attempted: '+JSON.stringify({cause:String(error?.message||error),changed:changed.map(x=>({path:x.path,backupId:x.backupId,created:x.created})),checks:checks.map(x=>({check:x.check,ok:x.ok,code:x.code})),rollbacks}).slice(0,18000));
  }
}
async function runtimeVersions(p={}){
  const commands=[['node',['--version']],['npm',['--version']],['git',['--version']],['python3',['--version']],['pip3',['--version']],['ffmpeg',['-version']],['ffprobe',['-version']],['yt-dlp',['--version']],['gallery-dl',['--version']]];
  const results=[];
  for(const [command,args] of commands){
    try{
      const r=await runProcess(command,args,{cwd:p.root?rootBase(p.root):process.cwd(),timeoutMs:Math.min(15000,Number(p.timeoutMs||8000)),maxOutput:12000});
      results.push({command,ok:r.ok,code:r.code,version:(r.stdout||r.stderr||'').split(/\r?\n/)[0].slice(0,500)});
    }catch(e){results.push({command,ok:false,error:String(e?.message||e).slice(0,500)})}
  }
  return{results};
}
async function npmList(p={}){
  const cwd=rootBase(p.root),r=await runProcess('npm',['ls','--depth=0','--json'],{cwd,timeoutMs:p.timeoutMs||60000,maxOutput:500000});
  let parsed=null;try{parsed=JSON.parse(r.stdout)}catch{}
  return{ok:r.ok,code:r.code,dependencies:parsed?.dependencies||null,stderr:r.stderr};
}
async function npmInstallSafe(p={}){
  if(cfg.allowDependencyInstall!==true)throw new Error('dependency install disabled by agent config');
  const pkg=String(p.package||'').trim();
  if(!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[a-z0-9._*^~<>=| -]+)?$/i.test(pkg)||pkg.length>180)throw new Error('invalid package spec');
  const cwd=rootBase(p.root),args=['install',pkg,'--save-exact'];if(p.allowScripts!==true)args.push('--ignore-scripts');
  const r=await runProcess('npm',args,{cwd,timeoutMs:Math.min(180000,Number(p.timeoutMs||180000)),maxOutput:500000});
  return{package:pkg,allowScripts:p.allowScripts===true,...r};
}
async function mkdir(p){const{out}=await safe(p.root,p.path,true);await fs.mkdir(out,{recursive:!!p.recursive});return{root:p.root,path:p.path,created:true}}
async function move(p){const a=await safe(p.root,p.path),b=await safe(p.root,p.toPath,true);if(fssync.existsSync(b.out)&&!p.overwrite)throw new Error('Destination exists');await fs.mkdir(path.dirname(b.out),{recursive:true});if(p.overwrite)await fs.rm(b.out,{recursive:true,force:true});await fs.rename(a.out,b.out);return{root:p.root,path:p.path,toPath:p.toPath}}
async function remove(p){const{out}=await safe(p.root,p.path),st=await fs.lstat(out);if(st.isDirectory()){if(!p.allowDir)throw new Error('Directory deletion disabled');const ents=await fs.readdir(out);if(ents.length)throw new Error('Directory not empty');await fs.rmdir(out);return{root:p.root,path:p.path,deleted:'dir'}}const b=await backup(p.root,p.path,'delete');await fs.unlink(out);return{root:p.root,path:p.path,deleted:'file',...b}}
async function rollback(p){const dir=path.join(BACKUP_DIR,String(p.backupId)),meta=JSON.parse(await fs.readFile(path.join(dir,'meta.json'),'utf8')),data=await fs.readFile(path.join(dir,'content.bin')),{out}=await safe(meta.root,meta.rel,true);if(fssync.existsSync(out))await backup(meta.root,meta.rel,'pre-rollback');await fs.mkdir(path.dirname(out),{recursive:true});await fs.writeFile(out,data);return{root:meta.root,path:meta.rel,restoredBackupId:p.backupId,afterSha:sha(data)}}
async function runCheck(p){
  const spec=cfg.safeChecks?.[p.check];if(!spec)throw new Error('Unknown check');const file=p.file?lexical(p.root,p.file).out:null,root=p.root?rootBase(p.root):process.cwd(),sub=x=>String(x).replaceAll('{file}',file||'').replaceAll('{root}',root),command=sub(spec.command),args=(spec.args||[]).map(sub),cwd=spec.cwdRoot?sub(spec.cwdRoot):root;
  return await new Promise((resolve,reject)=>{const cp=spawn(command,args,{cwd,stdio:['ignore','pipe','pipe'],shell:false,env:{...process.env,NO_COLOR:'1'}});let stdout='',stderr='';const cap=s=>s.length>200000?s.slice(-200000):s;cp.stdout.on('data',d=>stdout=cap(stdout+d));cp.stderr.on('data',d=>stderr=cap(stderr+d));const t=setTimeout(()=>{cp.kill('SIGKILL');reject(new Error('Check timeout'))},Math.min(600000,Math.max(1000,Number(p.timeoutMs||60000))));cp.on('error',reject);cp.on('close',code=>{clearTimeout(t);resolve({check:p.check,command,args,code,ok:code===0,stdout,stderr})})});
}

async function statPath(p){
  const {out}=await safe(p.root,p.path||'.'),st=await fs.lstat(out);
  return{root:p.root,path:p.path||'.',type:st.isDirectory()?'dir':st.isFile()?'file':st.isSymbolicLink()?'symlink':'other',size:st.size,mode:(st.mode&0o777).toString(8),mtime:st.mtime.toISOString(),ctime:st.ctime.toISOString()};
}
async function hashFile(p){
  const {out}=await safe(p.root,p.path),st=await fs.stat(out);if(!st.isFile())throw new Error('Not a file');if(st.size>MAX_READ*16)throw new Error('File too large to hash');
  const data=await fs.readFile(out);return{root:p.root,path:p.path,bytes:data.length,sha256:sha(data)};
}
async function chmodPath(p){
  const {out}=await safe(p.root,p.path);const mode=Number.parseInt(String(p.mode||''),8);if(!Number.isInteger(mode)||mode<0||mode>0o777)throw new Error('Invalid mode');
  await fs.chmod(out,mode);return{root:p.root,path:p.path,mode:mode.toString(8)};
}
async function runProcess(command,args,{cwd=process.cwd(),timeoutMs=60000,maxOutput=200000,env={}}={}){
  return await new Promise((resolve,reject)=>{const cp=spawn(command,args,{cwd,stdio:['ignore','pipe','pipe'],shell:false,env:{...process.env,...env,NO_COLOR:'1'}});let stdout='',stderr='';const cap=x=>x.length>maxOutput?x.slice(-maxOutput):x;cp.stdout.on('data',d=>stdout=cap(stdout+d));cp.stderr.on('data',d=>stderr=cap(stderr+d));const t=setTimeout(()=>{cp.kill('SIGKILL');reject(new Error('Process timeout'))},Math.min(180000,Math.max(1000,Number(timeoutMs)||60000)));cp.on('error',e=>{clearTimeout(t);reject(e)});cp.on('close',code=>{clearTimeout(t);resolve({command,args,code,ok:code===0,stdout,stderr})})});
}
async function systemInfo(){
  return{hostname:os.hostname(),platform:process.platform,arch:process.arch,release:os.release(),nodeVersion:process.version,pid:process.pid,agentUptime:process.uptime(),hostUptime:os.uptime(),loadavg:os.loadavg(),cpus:os.cpus().map(x=>({model:x.model,speed:x.speed})),memory:{total:os.totalmem(),free:os.freemem(),rss:process.memoryUsage().rss},cwd:process.cwd()};
}
async function processList(p={}){
  if(process.platform!=='linux')throw new Error('process.list currently requires Linux /proc');
  const limit=Math.min(500,Math.max(20,Number(p.limit||200)));
  const ids=(await fs.readdir('/proc')).filter(x=>/^\d+$/.test(x)).map(Number).sort((a,b)=>a-b);
  const items=[];
  for(const pid of ids){
    try{
      const [status,cmdBuf]=await Promise.all([
        fs.readFile('/proc/'+pid+'/status','utf8'),
        fs.readFile('/proc/'+pid+'/cmdline')
      ]);
      const name=(status.match(/^Name:\s+(.+)$/m)||[])[1]||'';
      const state=(status.match(/^State:\s+(.+)$/m)||[])[1]||'';
      const ppid=Number((status.match(/^PPid:\s+(\d+)$/m)||[])[1]||0);
      const rssKb=Number((status.match(/^VmRSS:\s+(\d+)\s+kB$/m)||[])[1]||0);
      const cmdline=cmdBuf.toString('utf8').split('\0').filter(Boolean).join(' ');
      items.push({pid,ppid,name,state,rssKb,cmdline:cmdline.slice(0,8000)});
      if(items.length>=limit)break;
    }catch{}
  }
  return{count:items.length,items};
}
function gitName(x,label){const v=String(x||'');if(!/^[A-Za-z0-9._\/-]+$/.test(v))throw new Error('Invalid '+label);return v}
async function gitStatus(p){const cwd=rootBase(p.root);return runProcess('git',['status','--porcelain=v1','--branch'],{cwd,timeoutMs:p.timeoutMs||30000});}
async function gitDiff(p){const cwd=rootBase(p.root),args=['diff','--no-ext-diff','--unified=3'];if(p.path){const rel=lexical(p.root,p.path).rel;args.push('--',rel)}return runProcess('git',args,{cwd,timeoutMs:p.timeoutMs||30000,maxOutput:400000});}
async function gitSync(p){
  const cwd=rootBase(p.root),remote=gitName(p.remote||'origin','remote'),branch=p.branch?gitName(p.branch,'branch'):null;
  const fetch=await runProcess('git',['fetch',remote,'--prune'],{cwd,timeoutMs:p.timeoutMs||120000,maxOutput:300000});if(!fetch.ok)return{stage:'fetch',fetch};
  const args=branch?['merge','--ff-only',remote+'/'+branch]:['pull','--ff-only'];
  const sync=await runProcess('git',args,{cwd,timeoutMs:p.timeoutMs||120000,maxOutput:300000});return{stage:'sync',fetch,sync,ok:sync.ok};
}
async function runtimeExec(p){
  if(cfg.allowExec!==true)throw new Error('runtime.exec disabled by agent config');
  const command=String(p.command||'').trim(),allow=new Set((cfg.execAllowlist||[]).map(String));if(!command||!allow.has(command))throw new Error('Executable not allowed');
  const args=Array.isArray(p.args)?p.args.slice(0,100).map(x=>String(x).slice(0,4000)):[];
  const cwd=p.root?rootBase(p.root):process.cwd();
  return runProcess(command,args,{cwd,timeoutMs:p.timeoutMs||60000,maxOutput:500000});
}
async function runtimeSignal(p){
  const pid=Number(p.pid),signal=String(p.signal||'SIGTERM');if(!Number.isInteger(pid)||pid<=1)throw new Error('Invalid pid');if(!['SIGTERM','SIGINT','SIGHUP','SIGUSR1','SIGUSR2'].includes(signal))throw new Error('Signal not allowed');
  process.kill(pid,signal);return{pid,signal,sent:true};
}

async function tailLogs(p){const f=cfg.logFiles?.[p.log];if(!f)throw new Error('Unknown log');const out=path.resolve(String(f)),st=await fs.stat(out),bytes=Math.min(st.size,Math.max(1024,Math.min(512000,Number(p.bytes||100000)))),h=await fs.open(out,'r'),buf=Buffer.alloc(bytes);await h.read(buf,0,bytes,st.size-bytes);await h.close();return{log:p.log,bytes,content:buf.toString('utf8')}}
async function restart(p){if(cfg.restartHook?.mode!=='file')throw new Error('Restart hook not configured');const hook=path.resolve(cfg.restartHook.path);await fs.mkdir(path.dirname(hook),{recursive:true});await fs.writeFile(hook,JSON.stringify({target:p.target||'all',reason:p.reason||'NexControl',requestedAt:new Date().toISOString(),nonce:crypto.randomUUID()},null,2));return{queued:true,target:p.target||'all',hook}}
async function execute(job){switch(job.kind){case'fs.list':return listDir(job.payload);case'fs.tree':return fsTree(job.payload);case'fs.read':return readFile(job.payload);case'fs.search':return searchFiles(job.payload);case'fs.compare':return compareFiles(job.payload);case'fs.write':return writeFile(job.payload);case'fs.mkdir':return mkdir(job.payload);case'fs.move':return move(job.payload);case'fs.copy':return copyPath(job.payload);case'fs.delete':return remove(job.payload);case'fs.rollback':return rollback(job.payload);case'fs.stat':return statPath(job.payload);case'fs.hash':return hashFile(job.payload);case'fs.chmod':return chmodPath(job.payload);case'backup.snapshot':return backupSnapshot(job.payload);case'deploy.pipeline':return deployPipeline(job.payload);case'deploy.patchPipeline':return deployPatchPipeline(job.payload);case'check.run':return runCheck(job.payload);case'logs.tail':return tailLogs(job.payload);case'logs.search':return searchLogs(job.payload);case'system.info':return systemInfo();case'process.list':return processList(job.payload);case'disk.usage':return diskUsage(job.payload);case'runtime.versions':return runtimeVersions(job.payload);case'dependency.npmList':return npmList(job.payload);case'dependency.npmInstall':return npmInstallSafe(job.payload);case'http.check':return httpCheck(job.payload);case'runtime.envKeys':return envKeys();case'runtime.envCheck':return envCheck(job.payload);case'git.status':return gitStatus(job.payload);case'git.diff':return gitDiff(job.payload);case'git.log':return gitLog(job.payload);case'git.branches':return gitBranches(job.payload);case'git.checkout':return gitCheckout(job.payload);case'git.commit':return gitCommit(job.payload);case'git.sync':return gitSync(job.payload);case'runtime.exec':return runtimeExec(job.payload);case'runtime.signal':return runtimeSignal(job.payload);case'runtime.restart':return restart(job.payload);default:throw new Error(`Unsupported job kind: ${job.kind}`)}}
async function heartbeat(){return api('/api/v1/agent/heartbeat',{displayName:NAME,version:'0.6.1',hostname:os.hostname(),platform:`${process.platform}/${process.arch}`,nodeVersion:process.version,pid:process.pid,uptime:process.uptime(),memory:process.memoryUsage(),capabilities:{jobs:["fs.list","fs.tree","fs.read","fs.search","fs.compare","fs.write","fs.mkdir","fs.move","fs.copy","fs.delete","fs.rollback","fs.stat","fs.hash","fs.chmod","backup.snapshot","deploy.pipeline","deploy.patchPipeline","check.run","logs.tail","logs.search","system.info","process.list","disk.usage","http.check","runtime.envKeys","runtime.envCheck","runtime.versions","dependency.npmList","dependency.npmInstall","git.status","git.diff","git.log","git.branches","git.checkout","git.commit","git.sync","runtime.exec","runtime.signal","runtime.restart"],safeChecks:Object.keys(cfg.safeChecks||{}),logs:Object.keys(cfg.logFiles||{})},roots:Object.keys(roots).map(key=>({key,path:roots[key]}))})}

let stopped=false;process.on('SIGINT',()=>stopped=true);process.on('SIGTERM',()=>stopped=true);let nextHeartbeat=0;
while(!stopped){
  try{
    if(Date.now()>=nextHeartbeat){await heartbeat();nextHeartbeat=Date.now()+HEARTBEAT_MS}
    const {jobs=[]}=await api('/api/v1/agent/jobs/claim',{limit:3});
    for(const job of jobs){try{const result=await execute(job);await api('/api/v1/agent/jobs/result',{jobId:job.id,ok:true,result})}catch(e){await api('/api/v1/agent/jobs/result',{jobId:job.id,ok:false,error:String(e?.stack||e).slice(0,20000)})}}
  }catch(e){console.error('[NexControlAgent]',new Date().toISOString(),String(e?.message||e))}
  await sleep(POLL_MS);
}
