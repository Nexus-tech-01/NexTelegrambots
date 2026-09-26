import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);
const STATE=process.env.NEX_LITEAPKS_STATE_FILE||'/var/lib/nex/state/internal-automation/nexcanal-watch-state-v2.json';
const SERVICE=process.env.NEX_LITEAPKS_SERVICE||'nex-liteapks-watcher.service';
const STALE_MS=Math.max(60_000,Number(process.env.NEX_LITEAPKS_WATCHDOG_STALE_MS||4*60*1000));
const OVERDUE_GRACE_MS=Math.max(60_000,Number(process.env.NEX_LITEAPKS_WATCHDOG_OVERDUE_GRACE_MS||20*60*1000));

async function restart(reason){
  console.warn('[NexLiteAPKWatchdog] restart:',reason);
  await execFileAsync('/bin/systemctl',['restart',SERVICE],{timeout:30000});
}
try{
  const raw=await fs.readFile(STATE,'utf8');
  const st=JSON.parse(raw);
  const now=Date.now();
  const updated=Date.parse(String(st.updatedAt||''));
  if(!Number.isFinite(updated)||now-updated>STALE_MS){
    await restart('state heartbeat stale');
    process.exit(0);
  }
  const queue=Array.isArray(st.queue)?st.queue:[];
  const health=st.health||{};
  const ready=queue.some(x=>Number(x.nextRetryAt||0)<=now);
  const nextAt=Number(health.nextPublicationAt||0);
  const processing=Number(health.processing||0);
  if(ready&&nextAt>0&&now>nextAt+OVERDUE_GRACE_MS&&processing===0){
    await restart('publication overdue with ready queue');
    process.exit(0);
  }
  console.log('[NexLiteAPKWatchdog] ok queue='+queue.length+' processing='+processing+' updatedAt='+st.updatedAt);
}catch(error){
  await restart('state unreadable: '+String(error?.message||error));
}
