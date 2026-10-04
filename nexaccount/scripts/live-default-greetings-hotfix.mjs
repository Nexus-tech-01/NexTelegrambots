import fs from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';

const base='/opt/nex/apps/public/nexai/current';
const runtimePath=base+'/runtime.mjs';
const compatPath=base+'/compat.mjs';

let runtime=fs.readFileSync(runtimePath,'utf8');
let compat=fs.readFileSync(compatPath,'utf8');

const legacyCond="  // Welcome/Goodbye are ON by default in every group.\n  // A group must explicitly store false to disable either feature.\n  if((welcome&&policy.welcome===false)||(goodbye&&policy.goodbye===false)||(!welcome&&!goodbye))return;";
const optInCond="  // Greetings are opt-in per group. A missing setting must never produce an\n  // unsolicited welcome/goodbye from newly connected NexAi sessions.\n  if((welcome&&policy.welcome!==true)||(goodbye&&policy.goodbye!==true)||(!welcome&&!goodbye))return;";
if(runtime.includes(legacyCond))runtime=runtime.replace(legacyCond,optInCond);
else if(!runtime.includes("policy.welcome!==true")||!runtime.includes("policy.goodbye!==true")){
  throw new Error('runtime_opt_in_greeting_marker_missing');
}

const legacyCurrent="    const current=(name==='welcome'||name==='goodbye')\n      ? stored!==false\n      : stored;";
const optInCurrent="    const current=(name==='welcome'||name==='goodbye')\n      ? stored===true\n      : stored;";
if(compat.includes(legacyCurrent))compat=compat.replace(legacyCurrent,optInCurrent);
else if(!compat.includes(optInCurrent))throw new Error('compat_opt_in_state_marker_missing');

const legacyStatus="'\\nWelcome : '+(policy.welcome!==false?'ON':'OFF')+'\\nGoodbye : '+(policy.goodbye!==false?'ON':'OFF')+extra";
const optInStatus="'\\nWelcome : '+(policy.welcome===true?'ON':'OFF')+'\\nGoodbye : '+(policy.goodbye===true?'ON':'OFF')+extra";
if(compat.includes(legacyStatus))compat=compat.replace(legacyStatus,optInStatus);
else if(!compat.includes(optInStatus))throw new Error('compat_opt_in_status_marker_missing');

fs.mkdirSync(base+'/.runtime',{recursive:true});
for(const [path,text,name] of [[runtimePath,runtime,'runtime.mjs'],[compatPath,compat,'compat.mjs']]){
  fs.copyFileSync(path,base+'/.runtime/'+name+'.before-opt-in-greetings-'+Date.now());
  const tmp=path+'.tmp-'+Date.now()+'.mjs';
  fs.writeFileSync(tmp,text);
  const chk=spawnSync(process.execPath,['--check',tmp],{encoding:'utf8'});
  if(chk.status!==0){
    try{fs.unlinkSync(tmp)}catch{}
    throw new Error('syntax_failed_'+name+':'+String(chk.stderr||chk.stdout||'').slice(0,1200));
  }
  fs.renameSync(tmp,path);
}

let pid=0;
let env={...process.env};
for(const n of fs.readdirSync('/proc')){
  if(!/^\\d+$/.test(n))continue;
  try{
    const cmd=fs.readFileSync('/proc/'+n+'/cmdline','utf8').replace(/\\0/g,' ').trim();
    if(cmd.includes('/opt/nex/apps/public/nexai/')&&cmd.endsWith('/daemon.mjs')){
      pid=Number(n);
      env={};
      for(const row of fs.readFileSync('/proc/'+n+'/environ','utf8').split(/\\0/).filter(Boolean)){
        const i=row.indexOf('=');
        if(i>0)env[row.slice(0,i)]=row.slice(i+1);
      }
      break;
    }
  }catch{}
}
if(!pid)throw new Error('live_daemon_not_found');

try{process.kill(pid,'SIGTERM')}catch{}
await new Promise(r=>setTimeout(r,1400));
const child=spawn(process.execPath,[base+'/bootstrap.mjs','--production'],{
  cwd:base,detached:true,stdio:'ignore',env
});
child.unref();

const port=env.NEXACCOUNT_PORT||'18120';
let health=null;
for(let i=0;i<40;i++){
  await new Promise(r=>setTimeout(r,500));
  try{
    const r=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(1500)});
    if(r.ok){health=await r.json();break}
  }catch{}
}
if(!health?.ok)throw new Error('health_not_restored');

const rt=fs.readFileSync(runtimePath,'utf8');
const cp=fs.readFileSync(compatPath,'utf8');
if(!rt.includes("policy.welcome!==true")||!rt.includes("policy.goodbye!==true"))throw new Error('runtime_opt_in_not_active');
if(!cp.includes("stored===true")||!cp.includes("policy.welcome===true")||!cp.includes("policy.goodbye===true"))throw new Error('compat_opt_in_not_active');

console.log(JSON.stringify({
  ok:true,
  oldPid:pid,
  worker:health.worker?.id||'',
  runtimeCount:health.runtimeCount,
  port,
  welcomeDefault:false,
  goodbyeDefault:false
}));
