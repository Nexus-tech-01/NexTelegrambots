import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const username=String(process.argv[2]||'').replace(/^@/,'').trim().toLowerCase();
if(!/^[a-z0-9_]{3,64}$/.test(username))throw new Error('username_required');
const release=process.env.NEXAI_DERIVE_RELEASE||'/opt/nex/apps/public/nexai/releases/independent-9a22317ef6-20261004111649';
const out=process.argv[3]||('/var/lib/nex/sessions/system/nexanime/'+username+'.session');
function run(c,a,env=process.env){const r=spawnSync(c,a,{encoding:'utf8',env,timeout:150000});if(r.error)throw r.error;if(r.status!==0)throw new Error(String(r.stderr||r.stdout).slice(-2500));return String(r.stdout||'')}
function envFile(){const e={...process.env};for(const raw of fs.readFileSync('/etc/nex/secrets/legacy-root.env','utf8').split(/\r?\n/)){let l=raw.trim();if(!l||l.startsWith('#'))continue;if(l.startsWith('export '))l=l.slice(7).trim();const i=l.indexOf('=');if(i<1)continue;let v=l.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);e[l.slice(0,i).trim()]=v}e.NEXACCOUNT_TELEGRAM_API_ID ||= e.NEXGROUP__TELEGRAM_API_ID||e.TELEGRAM_API_ID||'';e.NEXACCOUNT_TELEGRAM_API_HASH ||= e.NEXGROUP__TELEGRAM_API_HASH||e.TELEGRAM_API_HASH||'';return e}
async function health(){for(let i=0;i<60;i++){for(const p of [18120,18110]){try{const r=await fetch('http://127.0.0.1:'+p+'/health',{signal:AbortSignal.timeout(1500)});const j=await r.json();if(r.ok&&j.ok&&j.service==='nexaccount'&&Number(j.runtimeCount||0)>0)return {port:p,runtimeCount:j.runtimeCount}}catch{}}await new Promise(r=>setTimeout(r,1000))}throw new Error('core_health_timeout')}
let derived=false;let failure=null;
try{
 run('systemctl',['mask','--runtime','--now','nex-nexaccount.service']);
 fs.mkdirSync(path.dirname(out),{recursive:true});
 const r=spawnSync('/usr/bin/node',[path.join(release,'scripts/derive-independent-session.mjs'),'',username,out],{cwd:release,env:envFile(),encoding:'utf8',timeout:120000});
 if(r.error)throw r.error;
 if(r.status!==0)throw new Error('derive_failed '+String(r.stderr||r.stdout).slice(-2000));
 run('chown',['nex-public:nex',out]);run('chmod',['0600',out]);derived=true;
 console.log('[derive] independent session created @'+username);
}catch(error){failure=error;}
finally{
 try{run('systemctl',['unmask','--runtime','nex-nexaccount.service'])}catch{}
 try{run('systemctl',['start','nex-nexaccount.service'])}catch{}
 const h=await health();console.log('[derive] core healthy',JSON.stringify(h),'derived='+derived);
}
if(failure)throw failure;
