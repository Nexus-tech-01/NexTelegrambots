#!/usr/bin/env node
"use strict";
// NexControl independent inbound control plane using GitHub Actions OIDC.
// No GitHub PAT, no Vercel, no Supabase. Binds ONLY to 127.0.0.1.
// Public Nginx routes /_nxc/oidc/exec here; ALL writes require signed OIDC.
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const cp = require("node:child_process");
const path = require("node:path");

const HOST="127.0.0.1", PORT=18732;
const ISS="https://token.actions.githubusercontent.com";
const AUD="nxc-vps-control-20261010";
const REPO="Tresor562/Nexus-lab";
const REPO_ID="1327705715";
const ACTOR_ID="232972883";
const WORKFLOW_REF="Tresor562/Nexus-lab/.github/workflows/nxc-vps-control.yml@refs/heads/main";
const STATE="/var/lib/nxc-oidc-control";
const BIND_MAX=10000;
let keys=null, fetched=0;
const seen=new Map();
const log=(s)=>process.stdout.write(new Date().toISOString()+" "+s+"\n");
const respond=(res,code,data)=>{res.writeHead(code,{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(JSON.stringify(data));};
const b64=s=>Buffer.from(s.replace(/-/g,"+").replace(/_/g,"/"),"base64");
const parse=s=>JSON.parse(b64(s).toString("utf8"));
const fetchKeys=async()=>{
  if(keys&&Date.now()-fetched<3600000)return keys;
  return await new Promise((resolve,reject)=>{
    const r=https.get(ISS+"/.well-known/jwks",{timeout:11000,headers:{"User-Agent":"NexControl-OIDC/1.0"}},res=>{
      let data="";res.setEncoding("utf8");
      res.on("data",chunk=>{data+=chunk;if(data.length>100000)res.destroy();});
      res.on("end",()=>{try{
        if(res.statusCode!==200)throw Error("JWKS HTTP "+res.statusCode);
        const v=JSON.parse(data);if(!Array.isArray(v.keys))throw Error("No keys");
        keys=v.keys;fetched=Date.now();resolve(keys);
      }catch(e){reject(e)}});
    });r.on("timeout",()=>r.destroy(Error("JWKS timeout")));r.on("error",reject);
  });
};
const verify=async(token)=>{
  if(typeof token!=="string"||token.length>12000)throw Error("invalid JWT");
  const parts=token.split(".");if(parts.length!==3)throw Error("malformed JWT");
  const header=parse(parts[0]),claims=parse(parts[1]);
  if(header.alg!=="RS256"||!header.kid||header.typ&&header.typ!=="JWT")throw Error("unsupported JWT");
  let jwks=await fetchKeys(), key=jwks.find(k=>k.kid===header.kid&&k.kty==="RSA");
  if(!key){fetched=0;jwks=await fetchKeys();key=jwks.find(k=>k.kid===header.kid&&k.kty==="RSA");}
  if(!key)throw Error("unknown GitHub signing key");
  const ok=crypto.verify("RSA-SHA256",Buffer.from(parts[0]+"."+parts[1]),
    crypto.createPublicKey({key,format:"jwk"}),b64(parts[2]));
  if(!ok)throw Error("bad OIDC signature");
  const now=Math.floor(Date.now()/1000),aud=claims.aud;
  if(claims.iss!==ISS||!(Array.isArray(aud)?aud.includes(AUD):aud===AUD))throw Error("wrong OIDC issuer/audience");
  if(!Number.isFinite(claims.exp)||!Number.isFinite(claims.iat)||
     claims.exp<now||claims.iat>now+45||claims.iat<now-360||claims.exp>now+650||
     claims.nbf&&claims.nbf>now+45)throw Error("expired or unexpected time claims");
  if(claims.repository!==REPO||String(claims.repository_id)!==REPO_ID ||
     String(claims.actor_id)!==ACTOR_ID||claims.ref!=="refs/heads/main"||
     claims.event_name!=="push"||claims.workflow_ref!==WORKFLOW_REF||
     claims.sub!=="repo:"+REPO+":ref:refs/heads/main")throw Error("untrusted workflow identity");
  const digest=crypto.createHash("sha256").update(token).digest("hex");
  if(seen.has(digest)||fs.existsSync(path.join(STATE,digest)))throw Error("replayed OIDC token");
  fs.writeFileSync(path.join(STATE,digest),String(claims.exp),{flag:"wx",mode:0o600});
  seen.set(digest,claims.exp);
  // Stop accumulating old one-use nonce files.
  for(const [id,exp] of seen){if(exp<now-90){seen.delete(id);try{fs.unlinkSync(path.join(STATE,id))}catch{}}}
  return {actor:claims.actor,run_id:claims.run_id,sha:claims.sha};
};
const redact=x=>String(x).replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g,"[redacted]")
 .replace(/(Bearer\s+)[A-Za-z0-9_.-]{20,}/gi,"$1[redacted]")
 .replace(/((TOKEN|PASSWORD|SECRET|PRIVATE_KEY|API_KEY)\s*[=:]\s*)\S+/gi,"$1[redacted]");
const exec=job=>{
  if(!job||typeof job!=="object"||Array.isArray(job))throw Error("invalid job");
  if(!["ping","status","shell"].includes(job.action))throw Error("unsupported action");
  if(job.action==="ping")return {ok:true,action:"ping",hostname:require("node:os").hostname(),via:"nexcontrol-oidc-v1"};
  if(job.action==="status")return {ok:true,action:"status",uptimeSeconds:Math.round(require("node:os").uptime()),service:"nexcontrol-oidc-v1"};
  const command=job.command;
  if(typeof command!=="string"||!command.trim()||command.length>5500)throw Error("invalid shell command");
  const timeout=Math.min(110000,Math.max(1000,Number(job.timeout_ms)||25000));
  const p=cp.spawnSync("/bin/bash",["-c",command],{
    encoding:"utf8",timeout,maxBuffer:130000,
    env:{PATH:"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",LANG:"C.UTF-8",HOME:"/root"},
    cwd:"/root",uid:0,gid:0
  });
  return {ok:p.status===0&&!p.error,action:"shell",exit_code:p.status,
    timed_out:p.error?.code==="ETIMEDOUT",stdout:redact(p.stdout||"").slice(0,18000),
    stderr:redact(p.stderr||"").slice(0,3000)};
};
fs.mkdirSync(STATE,{recursive:true,mode:0o700});
const server=http.createServer(async(req,res)=>{
  if(req.url==="/healthz"&&req.method==="GET")
    return respond(res,200,{ok:true,service:"nxc-oidc-control",auth:"github-oidc"});
  if(req.url!=="/exec"||req.method!=="POST")
    return respond(res,404,{ok:false,error:"not_found"});
  let body="",length=0;
  req.on("data",part=>{length+=part.length;if(length>BIND_MAX){req.destroy();return}body+=part.toString("utf8")});
  req.on("end",async()=>{
    try{
      const a=/^Bearer ([A-Za-z0-9._-]+)$/.exec(req.headers.authorization||"");
      if(!a)throw Error("missing bearer");
      const identity=await verify(a[1]);
      const job=JSON.parse(body);
      const result=exec(job);
      log("run="+String(identity.run_id).slice(0,32)+" action="+job.action+" ok="+result.ok);
      respond(res,result.ok?200:422,result);
    }catch(e){
      log("rejected request: "+redact(e.message).slice(0,120));
      respond(res,403,{ok:false,error:"not_authorized_or_invalid_request"});
    }
  });
});
server.listen(PORT,HOST,()=>log("NexControl OIDC receiver listening on loopback "+HOST+":"+PORT));
