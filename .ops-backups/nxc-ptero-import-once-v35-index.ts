import {createClient} from "npm:@supabase/supabase-js@2";

const sb=createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {auth:{persistSession:false}}
);

const AGENT_SLUG="nexus-main";
const COMMIT="47b80ec6290127116f2825ca311256b4a6da979e";
const RAW_BASE="https://raw.githubusercontent.com/Nexus-tech-01/NexTelegrambots/"+COMMIT+"/nexaccount/";
const DEPLOY_KEY="ops_nexai_menu_recovery_"+COMMIT.slice(0,12);
const CREATED_BY="ops-nexai-menu-recovery-"+COMMIT.slice(0,8);
const FILES=[
  {name:"inline-bot.mjs",guard:"function schedulePollerSupervisor("},
  {name:"runtime.mjs",guard:"export function runtimeConnectionFor("},
  {name:"daemon.mjs",guard:"async function recoverInlineBotAfterRestore()"}
];

const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const J=(v:any,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{"content-type":"application/json","cache-control":"no-store"}});

async function setState(value:string){
  const {data:row}=await sb.from("nxc_config").select("key").eq("key",DEPLOY_KEY).maybeSingle();
  if(row)await sb.from("nxc_config").update({value,updated_at:new Date().toISOString()}).eq("key",DEPLOY_KEY);
  else await sb.from("nxc_config").insert({key:DEPLOY_KEY,value});
}
async function currentState(){
  const {data}=await sb.from("nxc_config").select("value").eq("key",DEPLOY_KEY).maybeSingle();
  return String(data?.value||"");
}
async function agentId(){
  const {data,error}=await sb.from("nxc_agents").select("id,enabled").eq("slug",AGENT_SLUG).maybeSingle();
  if(error)throw error;
  if(!data?.id||data.enabled!==true)throw new Error("nexus-main agent unavailable");
  return String(data.id);
}
async function job(agent_id:string,kind:string,payload:any,timeoutMs=180000){
  const {data,error}=await sb.from("nxc_agent_jobs").insert({agent_id,kind,payload,created_by:CREATED_BY}).select("id").single();
  if(error)throw error;
  const id=String(data.id),end=Date.now()+timeoutMs;
  while(Date.now()<end){
    const {data:row,error:readError}=await sb.from("nxc_agent_jobs").select("status,result,error").eq("id",id).single();
    if(readError)throw readError;
    const status=String(row?.status||"");
    if(status==="done"||status==="succeeded")return row?.result||{};
    if(status==="failed")throw new Error(kind+" failed: "+String(row?.error||"unknown").slice(0,1800));
    await sleep(700);
  }
  throw new Error(kind+" timeout");
}
async function runtimeRaw(agent_id:string,args:string[],timeoutMs=30000){
  const r=await job(agent_id,"runtime.exec",{root:"nexus",command:"node",args:["bots/nexaccount/cli.mjs",...args],timeoutMs},Math.max(60000,timeoutMs+30000));
  if(r?.ok===false||Number(r?.code||0)!==0)throw new Error("runtime "+args[0]+" failed: "+JSON.stringify(r).slice(-2200));
  return String(r?.stdout||"").trim();
}
async function runtimeJson(agent_id:string,args:string[],timeoutMs=30000){
  return JSON.parse((await runtimeRaw(agent_id,args,timeoutMs))||"{}");
}
async function runtimeJsonRetry(agent_id:string,args:string[],attempts=5,delayMs=1300){
  let last:any;
  for(let i=0;i<attempts;i++){
    try{return await runtimeJson(agent_id,args)}
    catch(e){last=e;if(i+1<attempts)await sleep(delayMs)}
  }
  throw last;
}
function assertCritical(accounts:any){
  const active=Array.isArray(accounts?.runtimes)?accounts.runtimes:[];
  const byName=new Map(active.filter((x:any)=>x?.connected===true).map((x:any)=>[String(x?.username||"").toLowerCase().replace(/^@/,""),x]));
  const primary:any=byName.get("tresor20001");
  const scanner:any=byName.get("tresor20009");
  if(!primary)throw new Error("critical runtime missing: @tresor20001");
  if(primary?.anime?.listener!==true||primary?.anime?.publisher!==true)throw new Error("@tresor20001 anime contract failed");
  if(!scanner)throw new Error("critical runtime missing: @tresor20009");
  if(scanner?.anime?.listener!==true)throw new Error("@tresor20009 anime listener contract failed");
  if(scanner?.liteApks?.scanner!==true||scanner?.liteApks?.running!==true)throw new Error("@tresor20009 LiteAPK scanner contract failed");
  return String(primary.telegramUserId||"");
}
async function waitBotReady(aid:string){
  let last:any={};
  for(let i=0;i<18;i++){
    try{
      last=await runtimeJson(aid,["health"]);
      if(last?.ok===true&&last?.pairingOnly!==true&&last?.botConfigured===true)return last;
    }catch(e){last={error:String((e as any)?.message||e)}}
    await sleep(4000);
  }
  throw new Error("bot_not_configured_after_recovery: "+JSON.stringify(last).slice(0,1200));
}

Deno.serve(async(req)=>{
  if(req.method!=="GET"&&req.method!=="POST")return J({ok:false,error:"method_not_allowed"},405);
  const backups:any[]=[];
  let aid="";
  try{
    const state=await currentState();
    if(state==="done")return J({ok:true,alreadyDone:true,commit:COMMIT,deploymentOk:true,automationsOk:true,botConfigured:true});

    aid=await agentId();
    await setState("running");

    const before=await runtimeJsonRetry(aid,["accounts"],3,900);
    assertCritical(before);

    const sources:any[]=[];
    for(const file of FILES){
      const res=await fetch(RAW_BASE+file.name,{headers:{accept:"text/plain"},signal:AbortSignal.timeout(20000)});
      if(!res.ok)throw new Error("source_fetch_"+file.name+"_http_"+res.status);
      const content=await res.text();
      if(!content.includes(file.guard))throw new Error("source_guard_failed_"+file.name);
      sources.push({...file,content});
    }

    for(const file of sources){
      const write=await job(aid,"fs.write",{root:"nexus",path:"bots/nexaccount/"+file.name,content:file.content});
      backups.push({name:file.name,backupId:String(write?.backupId||""),created:write?.created===true});
      const syntax=await job(aid,"check.run",{check:"node-check",root:"nexus",file:"bots/nexaccount/"+file.name,timeoutMs:60000});
      if(syntax?.ok!==true)throw new Error("node_check_failed_"+file.name);
    }

    const boot=await job(aid,"runtime.exec",{root:"nexus",command:"node",args:["bots/nexaccount/bootstrap.mjs","--restart","--production"],timeoutMs:60000},90000);
    if(boot?.ok===false)throw new Error("bootstrap_failed: "+JSON.stringify(boot).slice(-1800));

    const health=await waitBotReady(aid);
    if(health?.botConfigured!==true)throw new Error("bot_configured_contract_failed");

    const after=await runtimeJsonRetry(aid,["accounts"],5,1200);
    const primaryId=assertCritical(after);

    const anime=await runtimeJsonRetry(aid,["anime-status"],4,1000);
    if(anime?.ok!==true||anime?.enabled!==true)throw new Error("anime_status_unhealthy");
    if(String(anime?.destination||"").toLowerCase()!=="@theotaku_nexus")throw new Error("anime_destination_regression");
    if(Number(anime?.interSeriesMinutes||0)!==15)throw new Error("anime_cadence_regression");

    await sleep(1800);
    const probe=await runtimeJsonRetry(aid,["menu-probe",primaryId],3,2200);
    if(probe?.ok!==true||!probe?.resultId)throw new Error("menu_probe_failed: "+JSON.stringify(probe).slice(0,1200));

    await setState("done");
    return J({
      ok:true,alreadyDone:false,commit:COMMIT,deploymentOk:true,
      botConfigured:true,
      menuProbe:{ok:true,resultId:probe.resultId,resultType:probe.resultType||null},
      automationsOk:true,
      files:FILES.map(x=>x.name)
    });
  }catch(e){
    const error=String((e as any)?.message||e).slice(0,2400);
    let rollbackWarning="";
    try{
      if(aid){
        for(const item of [...backups].reverse()){
          if(item.backupId)await job(aid,"fs.rollback",{backupId:item.backupId},60000);
          else if(item.created)await job(aid,"fs.delete",{root:"nexus",path:"bots/nexaccount/"+item.name,allowDir:false},60000);
        }
        if(backups.length){
          await job(aid,"runtime.exec",{root:"nexus",command:"node",args:["bots/nexaccount/bootstrap.mjs","--restart","--production"],timeoutMs:60000},90000);
        }
      }
    }catch(re){rollbackWarning=String((re as any)?.message||re).slice(0,1000)}
    await setState("failed:"+error.slice(0,900)).catch(()=>{});
    return J({ok:false,error,rolledBack:backups.length>0,rollbackWarning},500);
  }
});