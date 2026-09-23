import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root=path.resolve(process.argv[2]||'.');
const strict=process.env.NEX_VPS_AUDIT_STRICT==='1';
const warnings=[];
const failures=[];
const info=[];

const exists=async rel=>{try{await fs.access(path.join(root,rel));return true}catch{return false}};
const read=async rel=>fs.readFile(path.join(root,rel),'utf8');
const hash=async rel=>crypto.createHash('sha256').update(await fs.readFile(path.join(root,rel))).digest('hex');

const required=[
  'nexcontrol/agent/index.mjs',
  'nexcontrol/agent/resource-watchdog.mjs',
  'nexaccount/package.json',
  'nexaccount/secure-rpc.mjs',
  'nexaccount/bootstrap.mjs',
  'nexcanal/liteapks-relay.mjs',
  'ops/vps/systemd/nexaccount@.service',
  'ops/vps/nexaccount.env.example',
  '.env.example',
  '.gitignore'
];
for(const rel of required){
  if(await exists(rel))info.push(`present:${rel}`);
  else failures.push(`missing required migration source: ${rel}`);
}

if(await exists('Dockerfile')){
  const docker=await read('Dockerfile');
  if(docker.includes('watchers/anime-pipeline.mjs.gz.b64') && !(await exists('watchers/anime-pipeline.mjs.gz.b64'))){
    warnings.push('Dockerfile references watchers/anime-pipeline.mjs.gz.b64, but that file is absent from the checkout');
  }
  if(docker.includes('RENDER_EXTERNAL_HOSTNAME'))warnings.push('Dockerfile still contains Render-specific hostname behavior');
}

const names=await fs.readdir(root);
const renderParts=names.filter(x=>/^render-src\.b64\.part-\d+$/.test(x)).sort();
if(renderParts.length){
  const byHash=new Map();
  for(const rel of renderParts){
    const sha=await hash(rel);const rows=byHash.get(sha)||[];rows.push(rel);byHash.set(sha,rows);
  }
  const duplicates=[...byHash.entries()].filter(([,rows])=>rows.length>1).map(([sha,rows])=>({sha,rows}));
  info.push(`render source parts:${renderParts.length}`);
  if(duplicates.length)warnings.push('duplicate render bundle chunks: '+duplicates.map(x=>x.rows.join(',')).join(' | '));
}

const directFleet=['nexgame','nexcanal','nexdownloader','nexgroup','nexstick'];
const missingDirect=[];
for(const bot of directFleet){
  if(!(await exists('bots/'+bot)))missingDirect.push(bot);
}
if(missingDirect.length){
  warnings.push('direct bot source directories are absent from the checkout and still depend on legacy bundle extraction: '+missingDirect.join(','));
}

if(await exists('.env.example')){
  const env=await read('.env.example');
  const hasDouble=/^NEXANIME__/m.test(env);
  const hasSingle=/^NEXANIME_(?!_)/m.test(env);
  if(hasDouble&&hasSingle)warnings.push('both NEXANIME__* and NEXANIME_* configuration families are documented; reconcile consumers before cutover');
  if(env.includes('/home/container/'))warnings.push('.env.example contains /home/container provider-specific paths');
}

for(const rel of ['nexaccount/anime-secondary-reader.mjs','nexaccount/store.mjs']){
  if(await exists(rel)){
    const src=await read(rel);
    if(src.includes('/home/container/'))warnings.push(rel+' retains a legacy /home/container fallback; VPS env must override it explicitly');
  }
}

for(const rel of ['nexaccount/secure-rpc.mjs','nexaccount/bootstrap.mjs']){
  if(await exists(rel)){
    const src=await read(rel);
    if(!src.includes('NEXACCOUNT_RUNTIME_DIR'))failures.push(rel+' does not support external NEXACCOUNT_RUNTIME_DIR');
  }
}

if(await exists('ops/vps/nexaccount.env.example')){
  const env=await read('ops/vps/nexaccount.env.example');
  for(const expected of [
    'NEXACCOUNT_RUNTIME_DIR=/var/lib/nex/runtime/nexaccount',
    'NEXANIME_SECONDARY_SESSION_FILE=/var/lib/nex/sessions/nexcanal-reader-session.txt',
    'NEXCANAL__WATCHER_ID_FILE=/var/lib/nex/sessions/nexcanal-watcher-id.txt'
  ]){
    if(!env.includes(expected))failures.push('VPS NexAccount template missing: '+expected);
  }
  if(/^NEXACCOUNT_WORKER_INDEX=/m.test(env))failures.push('shared NexAccount template must not pin one worker index; systemd instance supplies it');
}

if(await exists('README.md')){
  const readme=await read('README.md');
  if(/5 bots/i.test(readme))warnings.push('root README still describes the older five-bot Render fleet');
}

if(await exists('.gitignore')){
  const gi=await read('.gitignore');
  if(!/^\.env$/m.test(gi))failures.push('.gitignore does not explicitly ignore .env');
  if(!/^\.env\.\*$/m.test(gi))warnings.push('.gitignore does not ignore .env.* variants');
}

const output={
  root,
  strict,
  ok:failures.length===0 && (!strict||warnings.length===0),
  info,
  warnings,
  failures
};
console.log(JSON.stringify(output,null,2));
if(failures.length || (strict&&warnings.length))process.exit(1);
