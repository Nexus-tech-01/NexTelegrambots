#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root=path.resolve(process.argv[2]||'.');
const EXPECTED={
  nexgame:['nexgame'],
  nexcanal:['nexcanal','nexcanal-manager','nexcanal_manager'],
  nexdownloader:['nexdownloader','nex-downloader'],
  nexgroup:['nexgroup','nexgroup-manager','nexgroup_manager'],
  nexstick:['nexstick','nex-stick']
};
const ENTRY_NAMES=[
  'index.js','index.mjs','index.cjs','main.js','main.mjs','bot.js','bot.mjs',
  'app.js','app.mjs','server.js','server.mjs','src/index.js','src/index.mjs'
];
const FORBIDDEN_NAME_PATTERNS=[
  /^\.env(?:\..*)?$/i,
  /\.session(?:-journal)?$/i,
  /(^|[-_.])(cookies?|browser-profile|credentials?|secrets?)([-_.]|$)/i,
  /\.(pem|key|p12|pfx)$/i,
  /^id_(rsa|ed25519|ecdsa)$/i
];
const SKIP_DIRS=new Set(['node_modules','.git','.nexcontrol','downloads','download','tmp','cache','.cache','sessions','session']);
const SECRET_PATTERNS=[
  ['private-key',/BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/],
  ['mongodb-credential',/mongodb(?:\+srv)?:\/\/[^\s:]+:[^\s@]+@/i],
  ['telegram-bot-token',/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['generic-bearer',/\bBearer\s+[A-Za-z0-9._~+\/-]{24,}\b/i]
];

function fail(message){ console.error('[FAIL]',message); process.exitCode=1; }
function warn(message){ console.error('[WARN]',message); }
function ok(message){ console.log('[OK]',message); }

if(!fs.existsSync(root)||!fs.statSync(root).isDirectory()){
  console.error('Recovered source directory does not exist:',root);
  process.exit(2);
}

const files=[];
const dirs=[];
const symlinks=[];
function walk(dir,rel=''){
  for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
    const childRel=path.posix.join(rel,ent.name);
    const full=path.join(dir,ent.name);
    if(ent.isSymbolicLink()){ symlinks.push(childRel); continue; }
    if(ent.isDirectory()){
      dirs.push(childRel);
      if(SKIP_DIRS.has(ent.name)) continue;
      walk(full,childRel);
    }else if(ent.isFile()){
      files.push(childRel);
    }
  }
}
walk(root);

if(symlinks.length){
  fail('symlinks are not accepted in recovered source: '+symlinks.slice(0,20).join(', '));
}else ok('no symlinks found');

const forbiddenFiles=files.filter(rel=>FORBIDDEN_NAME_PATTERNS.some(re=>re.test(path.basename(rel))));
if(forbiddenFiles.length){
  fail('forbidden runtime/secret filenames found: '+forbiddenFiles.slice(0,30).join(', '));
}else ok('no forbidden runtime/secret filenames found');

const botRoot=path.join(root,'bots');
if(!fs.existsSync(botRoot)||!fs.statSync(botRoot).isDirectory()){
  fail('bots/ directory missing');
}

const detected={};
if(fs.existsSync(botRoot)&&fs.statSync(botRoot).isDirectory()){
  const children=fs.readdirSync(botRoot,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name);
  for(const [canonical,aliases] of Object.entries(EXPECTED)){
    const hit=aliases.find(name=>children.includes(name));
    if(hit){
      detected[canonical]=hit;
      const base=path.join(botRoot,hit);
      const pkg=path.join(base,'package.json');
      const entries=ENTRY_NAMES.filter(name=>fs.existsSync(path.join(base,name)));
      if(fs.existsSync(pkg)){
        try{
          const parsed=JSON.parse(fs.readFileSync(pkg,'utf8'));
          ok(`${canonical}: source=${hit}, package=${parsed.name||'(unnamed)'}@${parsed.version||'(no version)'}`);
        }catch{
          fail(`${canonical}: invalid package.json in bots/${hit}`);
        }
      }else{
        warn(`${canonical}: no package.json in bots/${hit}`);
      }
      if(entries.length) ok(`${canonical}: entrypoint candidate(s): ${entries.join(', ')}`);
      else warn(`${canonical}: no common entrypoint candidate detected; inspect package scripts/runtime orchestration`);
    }else{
      fail(`${canonical}: expected source directory not found (aliases: ${aliases.join(', ')})`);
    }
  }
}

const scriptsDir=path.join(root,'scripts');
if(!fs.existsSync(scriptsDir)||!fs.statSync(scriptsDir).isDirectory()){
  fail('scripts/ directory missing');
}else{
  const scriptNames=fs.readdirSync(scriptsDir,{withFileTypes:true}).filter(x=>x.isFile()).map(x=>x.name).sort();
  ok('scripts/ present with '+scriptNames.length+' files');
  for(const required of ['orchestrator.mjs','preflight.mjs','install-all.mjs','build-all.mjs']){
    if(scriptNames.includes(required)) ok('orchestration file present: scripts/'+required);
    else warn('orchestration file absent: scripts/'+required+' (may be valid if live runtime uses a different structure)');
  }
}

// Scan only reasonably sized text-like files. Values are never printed.
const suspicious=[];
const maxScan=4*1024*1024;
for(const rel of files){
  const full=path.join(root,rel);
  let st;
  try{ st=fs.statSync(full); }catch{ continue; }
  if(st.size===0||st.size>maxScan) continue;
  const ext=path.extname(rel).toLowerCase();
  const likelyText=['','.js','.mjs','.cjs','.ts','.tsx','.json','.md','.yaml','.yml','.sh','.py','.toml','.ini','.conf','.txt','.html','.css'].includes(ext);
  if(!likelyText) continue;
  let data;
  try{ data=fs.readFileSync(full,'utf8'); }catch{ continue; }
  for(const [label,re] of SECRET_PATTERNS){
    if(re.test(data)){ suspicious.push({file:rel,label}); break; }
  }
}
if(suspicious.length){
  fail('possible embedded credential material found in: '+suspicious.slice(0,30).map(x=>x.file+' ['+x.label+']').join(', '));
}else ok('no obvious embedded credential pattern found in scanned text source');

// Check static relative JS/TS imports so missing shared source is caught before Git import.
const sourceExts=new Set(['.js','.mjs','.cjs','.ts','.tsx','.jsx']);
const missingImports=[];
function relativeTargetExists(fromRel,spec){
  const base=path.resolve(root,path.dirname(fromRel),spec);
  const candidates=[
    base,
    ...['.js','.mjs','.cjs','.ts','.tsx','.jsx','.json'].map(ext=>base+ext),
    ...['index.js','index.mjs','index.cjs','index.ts','index.tsx','index.jsx','package.json'].map(name=>path.join(base,name))
  ];
  return candidates.some(candidate=>{
    const rel=path.relative(root,candidate);
    if(rel.startsWith('..')||path.isAbsolute(rel)) return false;
    try{return fs.statSync(candidate).isFile();}catch{return false;}
  });
}
for(const rel of files){
  if(!sourceExts.has(path.extname(rel).toLowerCase())) continue;
  let data;
  try{data=fs.readFileSync(path.join(root,rel),'utf8');}catch{continue;}
  const patterns=[
    /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for(const re of patterns){
    let m;
    while((m=re.exec(data))){
      const spec=m[1];
      if(!spec.startsWith('.')) continue;
      if(!relativeTargetExists(rel,spec)) missingImports.push({file:rel,spec});
    }
  }
}
if(missingImports.length){
  fail('missing static relative import target(s): '+missingImports.slice(0,40).map(x=>x.file+' -> '+x.spec).join(', '));
}else ok('all detected static relative imports resolve inside recovered source');

const lockfiles=['package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock'].filter(name=>fs.existsSync(path.join(root,name)));
if(lockfiles.length) ok('root lockfile(s): '+lockfiles.join(', '));
else warn('no root lockfile found');

const packageFiles=files.filter(x=>path.basename(x)==='package.json');
ok('package manifests found: '+packageFiles.length);

const hashes=[];
for(const rel of files.sort()){
  const full=path.join(root,rel);
  const h=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  hashes.push({path:rel,sha256:h,size:fs.statSync(full).size});
}
const report={
  inspectedAt:new Date().toISOString(),
  root,
  ok:process.exitCode!==1,
  expectedBots:Object.keys(EXPECTED),
  detectedBots:detected,
  fileCount:files.length,
  directoryCount:dirs.length,
  packageManifestCount:packageFiles.length,
  rootLockfiles:lockfiles,
  symlinkCount:symlinks.length,
  forbiddenFileCount:forbiddenFiles.length,
  suspiciousContentCount:suspicious.length,
  missingRelativeImportCount:missingImports.length,
  missingRelativeImports:missingImports,
  files:hashes
};
const reportPath=path.join(root,'RECOVERY_INSPECTION.json');
fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log('Inspection report:',reportPath);

if(process.exitCode===1){
  console.error('RECOVERED_SOURCE_INSPECTION=FAIL');
}else{
  console.log('RECOVERED_SOURCE_INSPECTION=PASS');
}
