import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const cfgPath = path.resolve(process.env.NEXCONTROL_AGENT_CONFIG || './agent.config.json');
const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
const KEY = process.env.NEXCONTROL_AGENT_KEY;
if (!KEY) throw new Error('NEXCONTROL_AGENT_KEY missing');
const CONTROL = String(cfg.controlUrl || '').replace(/\/$/, '');
if (!CONTROL) throw new Error('controlUrl missing');
const SLUG = cfg.agentSlug || os.hostname();
const NAME = cfg.agentName || SLUG;
const POLL_MS = Math.max(1000, Number(cfg.pollMs || 2500));
const HEARTBEAT_MS = Math.max(10000, Number(cfg.heartbeatMs || 30000));
const MAX_READ = Math.min(8 * 1024 * 1024, Math.max(4096, Number(cfg.maxReadBytes || 1024 * 1024)));
const MAX_SEARCH_FILES = Math.min(10000, Math.max(10, Number(cfg.maxSearchFiles || 2000)));
const BACKUP_DIR = path.resolve('.nexcontrol/backups');
await fs.mkdir(BACKUP_DIR, { recursive: true });

const roots = Object.fromEntries(Object.entries(cfg.roots || {}).map(([k,v]) => [k, path.resolve(String(v))]));
if (!Object.keys(roots).length) throw new Error('No roots configured');

async function api(endpoint, body={}) {
  const r = await fetch(CONTROL + endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-nexcontrol-agent': SLUG,
      'x-nexcontrol-agent-key': KEY,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`${endpoint}: HTTP ${r.status} ${data?.error || text}`);
  return data;
}

function rootBase(rootKey) {
  const base = roots[rootKey];
  if (!base) throw new Error(`Unknown root: ${rootKey}`);
  return base;
}

function lexicalResolve(rootKey, rel='') {
  const base = rootBase(rootKey);
  const out = path.resolve(base, String(rel || '.'));
  const r = path.relative(base, out);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error('Path escapes root');
  return { base, out, rel: r === '' ? '.' : r };
}

async function assertNoSymlinkEscape(rootKey, rel='', allowMissingLeaf=false) {
  const { base, out } = lexicalResolve(rootKey, rel);
  const baseReal = await fs.realpath(base);
  const parts = path.relative(base, out).split(path.sep).filter(Boolean);
  let cur = base;
  for (let i=0;i<parts.length;i++) {
    cur = path.join(cur, parts[i]);
    try {
      const st = await fs.lstat(cur);
      if (st.isSymbolicLink()) throw new Error('Symlink paths are not allowed');
    } catch (e) {
      if (e?.code === 'ENOENT' && allowMissingLeaf && i === parts.length - 1) break;
      if (e?.code === 'ENOENT' && allowMissingLeaf) continue;
      throw e;
    }
  }
  const parent = await fs.realpath(path.dirname(out)).catch(() => baseReal);
  const rr = path.relative(baseReal, parent);
  if (rr.startsWith('..') || path.isAbsolute(rr)) throw new Error('Real path escapes root');
  return { base, out };
}

async function backupFile(rootKey, rel, action='change') {
  const { out } = await assertNoSymlinkEscape(rootKey, rel);
  const data = await fs.readFile(out);
  const id = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const dir = path.join(BACKUP_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'content.bin'), data);
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ rootKey, rel, action, sha256: sha(data), createdAt: new Date().toISOString() }, null, 2));
  return { backupId: id, beforeSha: sha(data), bytes: data.length };
}

async function listDir(p) {
  const rootKey = p.root;
  const rel = p.path || '.';
  const { out } = await assertNoSymlinkEscape(rootKey, rel);
  const ents = await fs.readdir(out, { withFileTypes: true });
  const items = [];
  for (const e of ents.slice(0, 2000)) {
    const full = path.join(out, e.name);
    const st = await fs.lstat(full);
    items.push({ name:e.name, type:e.isDirectory()?'dir':e.isFile()?'file':e.isSymbolicLink()?'symlink':'other', size:st.size, mtime:st.mtime.toISOString() });
  }
  items.sort((a,b)=> (a.type==='dir'?0:1)-(b.type==='dir'?0:1) || a.name.localeCompare(b.name));
  return { root:rootKey, path:rel, items };
}

async function readFileJob(p) {
  const { out } = await assertNoSymlinkEscape(p.root, p.path);
  const st = await fs.stat(out);
  if (!st.isFile()) throw new Error('Not a file');
  if (st.size > MAX_READ) throw new Error(`File too large (${st.size} > ${MAX_READ})`);
  const buf = await fs.readFile(out);
  if (buf.includes(0)) throw new Error('Binary file');
  const content = buf.toString('utf8');
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, Number(p.startLine || 1));
  const end = Math.min(lines.length, Number(p.endLine || lines.length));
  return { root:p.root, path:p.path, sha256:sha(buf), bytes:buf.length, totalLines:lines.length, startLine:start, endLine:end, content:lines.slice(start-1,end).join('\n') };
}

async function searchJob(p) {
  const base = rootBase(p.root);
  const needle = String(p.query || '');
  if (!needle) throw new Error('query required');
  const start = lexicalResolve(p.root, p.path || '.').out;
  const out=[]; let visited=0;
  const ignored = new Set(['node_modules','.git','.nexcontrol','dist','build']);
  async function walk(dir) {
    if (visited >= MAX_SEARCH_FILES || out.length >= Math.min(200, Number(p.maxResults||100))) return;
    for (const e of await fs.readdir(dir,{withFileTypes:true})) {
      if (ignored.has(e.name)) continue;
      const full=path.join(dir,e.name); const rel=path.relative(base,full);
      if (e.isDirectory()) { await walk(full); if (visited>=MAX_SEARCH_FILES) return; continue; }
      if (!e.isFile()) continue; visited++;
      let st; try { st=await fs.stat(full); } catch { continue; }
      if (st.size>MAX_READ) continue;
      let buf; try { buf=await fs.readFile(full); } catch { continue; }
      if (buf.includes(0)) continue;
      const text=buf.toString('utf8');
      const lines=text.split(/\r?\n/);
      for (let i=0;i<lines.length;i++) {
        if ((p.caseSensitive?lines[i]:lines[i].toLowerCase()).includes(p.caseSensitive?needle:needle.toLowerCase())) {
          out.push({path:rel,line:i+1,text:lines[i].slice(0,500)});
          if (out.length>=Math.min(200, Number(p.maxResults||100))) return;
        }
      }
    }
  }
  await walk(start);
  return {root:p.root,path:p.path||'.',query:needle,visited,matches:out};
}

async function writeJob(p) {
  const { out } = await assertNoSymlinkEscape(p.root, p.path, true);
  const exists = fssync.existsSync(out);
  let beforeSha=null, backupId=null;
  if (exists) {
    const old=await fs.readFile(out);
    beforeSha=sha(old);
    if (p.expectedSha && p.expectedSha !== beforeSha) throw new Error(`SHA mismatch: expected ${p.expectedSha}, actual ${beforeSha}`);
    ({backupId}=await backupFile(p.root,p.path,'write'));
  } else {
    await fs.mkdir(path.dirname(out),{recursive:true});
  }
  const content = Buffer.from(String(p.content ?? ''),'utf8');
  if (content.length > MAX_READ*4) throw new Error('Write payload too large');
  const tmp = `${out}.nxc-${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp,content,{mode:0o600});
  await fs.rename(tmp,out);
  return {root:p.root,path:p.path,created:!exists,beforeSha,afterSha:sha(content),backupId,bytes:content.length};
}

async function mkdirJob(p){const {out}=await assertNoSymlinkEscape(p.root,p.path,true);await fs.mkdir(out,{recursive:!!p.recursive});return{root:p.root,path:p.path,created:true}}
async function moveJob(p){const a=await assertNoSymlinkEscape(p.root,p.path);const b=await assertNoSymlinkEscape(p.root,p.toPath,true);if(fssync.existsSync(b.out)&&!p.overwrite)throw new Error('Destination exists');await fs.mkdir(path.dirname(b.out),{recursive:true});if(p.overwrite)await fs.rm(b.out,{recursive:true,force:true});await fs.rename(a.out,b.out);return{root:p.root,path:p.path,toPath:p.toPath}}
async function deleteJob(p){const {out}=await assertNoSymlinkEscape(p.root,p.path);const st=await fs.lstat(out);if(st.isDirectory()){if(!p.allowDir)throw new Error('Directory deletion disabled');const ents=await fs.readdir(out);if(ents.length)throw new Error('Directory not empty');await fs.rmdir(out);return{root:p.root,path:p.path,deleted:'dir'}}const b=await backupFile(p.root,p.path,'delete');await fs.unlink(out);return{root:p.root,path:p.path,deleted:'file',...b}}
async function rollbackJob(p){const metaPath=path.join(BACKUP_DIR,String(p.backupId),'meta.json');const contentPath=path.join(BACKUP_DIR,String(p.backupId),'content.bin');const meta=JSON.parse(await fs.readFile(metaPath,'utf8'));const {out}=await assertNoSymlinkEscape(meta.rootKey,meta.rel,true);if(fssync.existsSync(out))await backupFile(meta.rootKey,meta.rel,'pre-rollback');await fs.mkdir(path.dirname(out),{recursive:true});const data=await fs.readFile(contentPath);await fs.writeFile(out,data);return{root:meta.rootKey,path:meta.rel,restoredBackupId:p.backupId,afterSha:sha(data)}}

async function runCheck(p){const spec=cfg.safeChecks?.[p.check];if(!spec)throw new Error('Unknown check');const file=p.file?lexicalResolve(p.root,p.file).out:null;const root=p.root?rootBase(p.root):process.cwd();const sub=x=>String(x).replaceAll('{file}',file||'').replaceAll('{root}',root);const command=sub(spec.command);const args=(spec.args||[]).map(sub);const cwd=spec.cwdRoot?sub(spec.cwdRoot):root;return await new Promise((resolve,reject)=>{const cp=spawn(command,args,{cwd,stdio:['ignore','pipe','pipe'],shell:false,env:{...process.env,NO_COLOR:'1'}});let stdout='',stderr='';const cap=s=>s.length>200000?s.slice(-200000):s;cp.stdout.on('data',d=>stdout=cap(stdout+d));cp.stderr.on('data',d=>stderr=cap(stderr+d));const t=setTimeout(()=>{cp.kill('SIGKILL');reject(new Error('Check timeout'))},Math.min(120000,Number(p.timeoutMs||60000)));cp.on('error',reject);cp.on('close',code=>{clearTimeout(t);resolve({check:p.check,command,args,code,ok:code===0,stdout,stderr})})})}
async function tailLogs(p){const f=cfg.logFiles?.[p.log];if(!f)throw new Error('Unknown log');const out=path.resolve(String(f));const st=await fs.stat(out);const bytes=Math.min(st.size,Math.max(1024,Math.min(512000,Number(p.bytes||100000))));const h=await fs.open(out,'r');const buf=Buffer.alloc(bytes);await h.read(buf,0,bytes,st.size-bytes);await h.close();return{log:p.log,bytes,content:buf.toString('utf8')}}
async function restartJob(p){if(cfg.restartHook?.mode!=='file')throw new Error('Restart hook not configured');const hook=path.resolve(cfg.restartHook.path);await fs.mkdir(path.dirname(hook),{recursive:true});await fs.writeFile(hook,JSON.stringify({target:p.target||'all',reason:p.reason||'NexControl',requestedAt:new Date().toISOString()},null,2));return{queued:true,target:p.target||'all',hook}}

async function execute(job){switch(job.kind){case'fs.list':return listDir(job.payload);case'fs.read':return readFileJob(job.payload);case'fs.search':return searchJob(job.payload);case'fs.write':return writeJob(job.payload);case'fs.mkdir':return mkdirJob(job.payload);case'fs.move':return moveJob(job.payload);case'fs.delete':return deleteJob(job.payload);case'fs.rollback':return rollbackJob(job.payload);case'check.run':return runCheck(job.payload);case'logs.tail':return tailLogs(job.payload);case'runtime.restart':return restartJob(job.payload);default:throw new Error(`Unsupported job kind: ${job.kind}`)}}

async function heartbeat(){return api('/api/v1/agent/heartbeat',{displayName:NAME,version:'0.1.0',hostname:os.hostname(),platform:`${process.platform}/${process.arch}`,nodeVersion:process.version,pid:process.pid,uptime:process.uptime(),memory:process.memoryUsage(),capabilities:{jobs:['fs.list','fs.read','fs.search','fs.write','fs.mkdir','fs.move','fs.delete','fs.rollback','check.run','logs.tail','runtime.restart'],safeChecks:Object.keys(cfg.safeChecks||{}),logs:Object.keys(cfg.logFiles||{})},roots:Object.keys(roots).map(key=>({key,path:roots[key]}))})}

let stopped=false;
process.on('SIGINT',()=>stopped=true);process.on('SIGTERM',()=>stopped=true);
let nextHeartbeat=0;
while(!stopped){
  try{
    if(Date.now()>=nextHeartbeat){await heartbeat();nextHeartbeat=Date.now()+HEARTBEAT_MS}
    const {jobs=[]}=await api('/api/v1/agent/jobs/claim',{limit:3});
    for(const job of jobs){
      try{const result=await execute(job);await api('/api/v1/agent/jobs/result',{jobId:job.id,ok:true,result})}
      catch(e){await api('/api/v1/agent/jobs/result',{jobId:job.id,ok:false,error:String(e?.stack||e)})}
    }
  }catch(e){console.error('[NexControlAgent]',new Date().toISOString(),String(e?.message||e))}
  await sleep(POLL_MS)
}
