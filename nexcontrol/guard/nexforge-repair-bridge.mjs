import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ROOT=path.resolve(process.env.NEX_ROOT||'/opt/nex/current');
const MCP_URL=String(process.env.NEXFORGE_MCP_URL||'').trim();
const MCP_TOKEN=String(process.env.NEXFORGE_MCP_TOKEN||'').trim();
const PROJECT=String(process.env.NEXFORGE_SUPERVISION_PROJECT||'NexTelegrambots');
const POLL_MS=Math.max(5000,Number(process.env.NEXFORGE_REPAIR_BRIDGE_INTERVAL_MS||10000));
const RUNTIME=path.resolve(process.env.NEXFORGE_REPAIR_BRIDGE_RUNTIME||'/var/lib/nex/runtime/nexforge-repair-bridge');
const NEXGUARD_RUNTIME=path.resolve(process.env.NEXGUARD_RUNTIME||'/var/lib/nex/runtime/nexguard');
const AUTOMATION_RUNTIME=path.resolve(process.env.NEX_AUTOMATION_RUNTIME||'/var/lib/nex/runtime/automation-supervisor');
const SUPABASE_URL=String(process.env.SUPABASE_URL||process.env.NEXT_PUBLIC_SUPABASE_URL||'https://ojbyvjqurlamplmujmyu.supabase.co').trim().replace(/\/+$/,'');
const HOST_PUBLISHABLE=String(process.env.PUBLISHABLE_KEY||process.env.SUPABASE_ANON_KEY||process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||'').trim();
const HOST_AGENT_ID=String(process.env.AGENT_ID||'').trim();
const HOST_AGENT_KEY=String(process.env.AGENT_KEY||'').trim();
const DIRECT_ENABLED=Boolean(SUPABASE_URL&&HOST_PUBLISHABLE&&HOST_AGENT_ID&&HOST_AGENT_KEY);
const STATE_FILE=path.join(RUNTIME,'state.json');
const SOURCES=[
  {name:'nexguard',file:path.join(NEXGUARD_RUNTIME,'repair-requests.jsonl')},
  {name:'automation-supervisor',file:path.join(AUTOMATION_RUNTIME,'repair-requests.jsonl')}
];

await fs.mkdir(RUNTIME,{recursive:true});
const readJson=async(file,fallback)=>{try{return JSON.parse(await fs.readFile(file,'utf8'))}catch{return fallback}};
async function writeJsonAtomic(file,data){const tmp=file+'.tmp-'+process.pid;await fs.writeFile(tmp,JSON.stringify(data,null,2),{mode:0o600});await fs.rename(tmp,file)}
function nowIso(){return new Date().toISOString()}
function priority(v){
  const s=String(v||'').toLowerCase();
  return s==='critical'?4:s==='high'?3:s==='medium'?2:s==='low'?1:2;
}
function connectorUrl(){
  if(!MCP_URL)return '';
  try{
    const u=new URL(MCP_URL);
    if(!u.searchParams.has('mcp'))u.searchParams.set('mcp','1');
    return u.toString();
  }catch{return MCP_URL}
}
async function callTool(name,args){
  const url=connectorUrl();
  if(!url)throw new Error('NEXFORGE_MCP_URL_missing');
  const headers={'content-type':'application/json','mcp-protocol-version':'2025-03-26'};
  if(MCP_TOKEN)headers.authorization='Bearer '+MCP_TOKEN;
  const body={jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args||{}}};
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),15000);
  try{
    const res=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal:ctl.signal});
    const text=await res.text();
    if(!res.ok)throw new Error('NexForge MCP HTTP '+res.status+': '+text.slice(0,500));
    let data;try{data=JSON.parse(text)}catch{throw new Error('NexForge MCP invalid JSON')}
    if(data?.error)throw new Error('NexForge MCP error: '+JSON.stringify(data.error));
    return data?.result;
  }finally{clearTimeout(timer)}
}



async function hostRpc(name,payload){
  if(!DIRECT_ENABLED)throw new Error('host_rpc_unavailable');
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),15000);
  try{
    const res=await fetch(SUPABASE_URL+'/rest/v1/rpc/'+name,{
      method:'POST',
      headers:{
        apikey:HOST_PUBLISHABLE,
        authorization:'Bearer '+HOST_PUBLISHABLE,
        'content-type':'application/json'
      },
      body:JSON.stringify(payload||{}),
      signal:ctl.signal
    });
    const text=await res.text();
    if(!res.ok)throw new Error('Host RPC '+name+' '+res.status+': '+text.slice(0,500));
    if(!text)return null;
    try{return JSON.parse(text)}catch{return text}
  }finally{clearTimeout(timer)}
}
async function createTaskDirect(args){
  const externalRef='nexguard:'+crypto.createHash('sha256').update(JSON.stringify({
    project:args.project,title:args.title,origin:args.payload?.origin,signature:args.payload?.incidentSignature,kind:args.payload?.incidentKind
  })).digest('hex').slice(0,40);
  const result=await hostRpc('nxf_host_create_repair_task',{
    p_agent_id:HOST_AGENT_ID,
    p_agent_key:HOST_AGENT_KEY,
    p_task:{
      external_ref:externalRef,
      title:args.title,
      description:args.description,
      project:args.project,
      executor:args.executor||'shared',
      priority:args.priority||2,
      payload:args.payload||{}
    }
  });
  return {...(result||{}),transport:'host-rpc'};
}
let lastLeaseSweep=0;
async function recoverExpiredLeases(){
  if(!DIRECT_ENABLED||Date.now()-lastLeaseSweep<60000)return;
  lastLeaseSweep=Date.now();
  const result=await hostRpc('nxf_host_reap_repairs',{
    p_agent_id:HOST_AGENT_ID,
    p_agent_key:HOST_AGENT_KEY
  });
  state.lastLeaseSweep={at:nowIso(),result};
}

let state=await readJson(STATE_FILE,{version:1,sources:{},posted:{}});
state.sources=state.sources||{};
state.posted=state.posted||{};
let stopping=false;
process.on('SIGTERM',()=>stopping=true);
process.on('SIGINT',()=>stopping=true);

function taskKey(source,row){
  return String(row.incidentSignature||row.signature||row.id||crypto.createHash('sha1').update(JSON.stringify(row)).digest('hex'))+'|'+String(row.kind||'repair')+'|'+source;
}
function taskTitle(source,row){
  const label=String(row.incidentKind||row.kind||'repair').replace(/[_-]+/g,' ').trim();
  const target=String(row.target||row.evidence?.name||'').trim();
  return ('['+source+'] '+label+(target?' · '+target:'')).slice(0,180);
}
function taskDescription(source,row){
  const instruction=String(row.instruction||'Diagnose and repair the incident safely.');
  const evidence=JSON.stringify(row.evidence??row.repairResult??{},null,2);
  return [
    'Origin: '+source,
    'Incident: '+String(row.incidentKind||row.kind||'repair'),
    'Signature: '+String(row.incidentSignature||row.signature||''),
    '',
    instruction,
    '',
    'Required workflow: inspect shared tasks/locks, claim this task, lock affected resources, diagnose from current state/logs, persist source changes to Git, run targeted and regression tests, deploy through NexControl/NexForge, verify production, roll back on regression, then release locks.',
    '',
    'Evidence:',
    evidence.slice(0,12000)
  ].join('\n');
}

async function postRow(source,row){
  const key=taskKey(source,row);
  const last=Date.parse(String(state.posted[key]?.postedAt||0))||0;
  if(last&&Date.now()-last<12*60*60*1000)return {skipped:'recently_posted'};

  const taskArgs={
    title:taskTitle(source,row),
    description:taskDescription(source,row),
    project:PROJECT,
    executor:'shared',
    priority:priority(row.priority||row.severity),
    payload:{
      origin:source,
      incidentSignature:String(row.incidentSignature||row.signature||''),
      incidentKind:String(row.incidentKind||row.kind||'repair'),
      sourceEventId:String(row.id||''),
      createdAt:String(row.createdAt||row.detectedAt||nowIso())
    }
  };
  let result;
  try{
    if(!MCP_URL)throw new Error('NEXFORGE_MCP_URL_missing');
    result=await callTool('create_task',taskArgs);
  }catch(error){
    if(!DIRECT_ENABLED)throw error;
    console.warn('[NexForgeRepairBridge] MCP unavailable, using direct Supabase fallback:',String(error?.message||error));
    result=await createTaskDirect(taskArgs);
  }
  state.posted[key]={postedAt:nowIso(),result};
  return {posted:true,result};
}

async function readNewLines(source){
  const st=state.sources[source.name]||{offset:0};
  let raw;
  try{raw=await fs.readFile(source.file)}catch(error){
    if(error?.code==='ENOENT')return [];
    throw error;
  }
  let offset=Math.max(0,Number(st.offset||0));
  if(offset>raw.length)offset=0;
  const rows=[];
  let cursor=offset;
  while(cursor<raw.length){
    const nl=raw.indexOf(10,cursor);
    if(nl<0)break; // keep an incomplete trailing JSONL record for the next cycle
    const line=raw.subarray(cursor,nl).toString('utf8').trim();
    const nextOffset=nl+1;
    if(line){
      try{rows.push({row:JSON.parse(line),nextOffset})}
      catch(error){
        // Malformed complete lines are consumed so one bad record cannot block the bridge forever.
        rows.push({row:null,nextOffset,parseError:String(error?.message||error),rawPreview:line.slice(0,500)});
      }
    }else{
      rows.push({row:null,nextOffset});
    }
    cursor=nextOffset;
  }
  state.sources[source.name]={...st,offset};
  return rows;
}

console.log('[NexForgeRepairBridge] started sources='+SOURCES.length);
while(!stopping){
  try{
    await recoverExpiredLeases();
    if(!MCP_URL&&!DIRECT_ENABLED){
      console.warn('[NexForgeRepairBridge] neither NexForge MCP nor Supabase direct fallback is configured');
    }else{
      for(const source of SOURCES){
        const records=await readNewLines(source);
        for(const record of records){
          const st=state.sources[source.name]||{offset:0};
          if(record.parseError){
            console.error('[NexForgeRepairBridge] malformed JSONL record',source.name,record.parseError,record.rawPreview||'');
            st.offset=record.nextOffset;
            state.sources[source.name]=st;
            continue;
          }
          if(!record.row){
            st.offset=record.nextOffset;
            state.sources[source.name]=st;
            continue;
          }
          try{
            await postRow(source.name,record.row);
            // Advance only after this exact record was accepted or deduplicated.
            st.offset=record.nextOffset;
            state.sources[source.name]=st;
          }catch(error){
            console.error('[NexForgeRepairBridge] post failed',source.name,String(error?.message||error));
            // Keep the offset on the failed record so it is retried next cycle.
            break;
          }
        }
      }
    }
    // Bound local dedupe history.
    const entries=Object.entries(state.posted).sort((a,b)=>Date.parse(String(b[1]?.postedAt||0))-Date.parse(String(a[1]?.postedAt||0))).slice(0,2000);
    state.posted=Object.fromEntries(entries);
    state.updatedAt=nowIso();
    await writeJsonAtomic(STATE_FILE,state);
  }catch(error){console.error('[NexForgeRepairBridge] cycle failed',String(error?.stack||error))}
  await sleep(POLL_MS);
}
console.log('[NexForgeRepairBridge] stopped');
