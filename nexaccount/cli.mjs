import fs from 'node:fs';
import { decryptPairingEnvelope, pairingPublicKey } from './secure-rpc.mjs';

const workerIndex=Math.max(0,Number(process.env.NEXACCOUNT_WORKER_INDEX||0));

function discoverRuntimePort(){
  const explicit=Number(process.env.NEXACCOUNT_PORT||0);
  if(Number.isInteger(explicit)&&explicit>0&&explicit<65536)return explicit;
  try{
    const numeric=x=>x&&[...x].every(ch=>ch>='0'&&ch<='9');
    const zero=String.fromCharCode(0);
    const candidates=[];
    for(const pid of fs.readdirSync('/proc').filter(numeric)){
      try{
        const argv=fs.readFileSync('/proc/'+pid+'/cmdline').toString().split(zero).filter(Boolean);
        const entry=String(argv[1]||'');
        const isPublicNexAi=entry==='/opt/nex/apps/public/nexai/current/daemon.mjs'
          ||entry.includes('/opt/nex/apps/public/nexai/releases/');
        const isNexAccount=entry.endsWith('/nexaccount/daemon.mjs');
        if(!isPublicNexAi&&!isNexAccount)continue;
        const env=fs.readFileSync('/proc/'+pid+'/environ').toString().split(zero);
        const row=env.find(x=>x.startsWith('NEXACCOUNT_PORT='));
        const found=Number(row?.slice('NEXACCOUNT_PORT='.length)||0);
        if(!Number.isInteger(found)||found<=0||found>=65536)continue;
        let score=isPublicNexAi?100:10;
        try{
          const cgroup=fs.readFileSync('/proc/'+pid+'/cgroup','utf8');
          if(cgroup.includes('nex-nexaccount.service'))score+=50;
          if(cgroup.includes('nexcontrol-agent.service'))score-=25;
        }catch{}
        candidates.push({port:found,score,pid:Number(pid)});
      }catch{}
    }
    candidates.sort((a,b)=>b.score-a.score||b.pid-a.pid);
    if(candidates.length)return candidates[0].port;
  }catch{}
  return 3491+workerIndex;
}

const port=discoverRuntimePort();
const base='http://127.0.0.1:'+port;
const controlKey=String(process.env.NEXACCOUNT_CONTROL_KEY||process.env.NEXCONTROL_FLEET_KEY||process.env.NEXACCOUNT_SESSION_KEY||process.env.NEXCONTROL_SESSION_SECRET||process.env.SESSION_SECRET||'').trim();

async function call(method,path,payload,timeoutMs=30000){
  const r=await fetch(base+path,{
    method,
    headers:{...(payload?{'content-type':'application/json'}:{}),...(controlKey?{'x-nexaccount-key':controlKey}:{})},
    body:payload?JSON.stringify(payload):undefined,
    signal:AbortSignal.timeout(timeoutMs)
  });
  const text=await r.text();
  let data;try{data=JSON.parse(text)}catch{data={ok:false,error:text}}
  if(!r.ok)throw new Error(data.error||('HTTP '+r.status));
  return data;
}

async function secureRpc(envelope){
  const q=await decryptPairingEnvelope(envelope);
  switch(q.action){
    case 'pair-start':
      return call('POST','/pair/start',{phone:String(q.phone||'')});
    case 'pair-code':
      return call('POST','/pair/code',{id:String(q.id||''),code:String(q.code||'')});
    case 'pair-password':
      return call('POST','/pair/password',{id:String(q.id||''),password:String(q.password||'')});
    default:
      throw new Error('Unsupported secure pairing action');
  }
}

const [command,...args]=process.argv.slice(2);
try{
  let out;
  switch(command){
    case 'health':out=await call('GET','/health');break;
    case 'accounts':out=await call('GET','/accounts');break;
    case 'engines':out=await call('GET','/engines');break;
    case 'conversation-list':
      out=await call('GET','/conversation/list?telegramUserId='+encodeURIComponent(String(args[0]||''))+'&limit='+Math.max(1,Math.min(250,Number(args[1]||100))));
      break;
    case 'conversation-history':
      if(!args[1])throw new Error('telegram user id and chat id required');
      out=await call('GET','/conversation/history?telegramUserId='+encodeURIComponent(String(args[0]||''))+'&chatId='+encodeURIComponent(String(args[1]))+'&limit='+Math.max(1,Math.min(200,Number(args[2]||80))));
      break;
    case 'menu-probe':
      if(!args[0])throw new Error('telegram user id required');
      out=await call('POST','/diagnostics/menu',{telegramUserId:args[0],peer:args[1]||'me'});
      break;
    case 'conversation-send-file': {
      const file=String(args[0]||'');
      if(!file||!file.startsWith('.runtime/nexcontrol-compose-'))throw new Error('compose file required');
      const payload=JSON.parse(fs.readFileSync(file,'utf8'));
      try{out=await call('POST','/conversation/send',payload,180000)}
      finally{try{fs.unlinkSync(file)}catch{}}
      break;
    }
    case 'command-test':
      if(!args[0]||!args[1])throw new Error('telegram user id and command text required');
      out=await call('POST','/diagnostics/command',{telegramUserId:args[0],text:args[1],peer:args[2]||'me'});
      break;
    case 'group-smoke':
      if(!args[0])throw new Error('telegram user id required');
      out=await call('POST','/diagnostics/group',{telegramUserId:args[0]},120000);
      break;
    case 'auto-join-all':
      out=await call('POST','/diagnostics/auto-join',{telegramUserId:args[0]||'',username:args[0]||''},300000);
      break;
    case 'automation-probe':
      out=await call('POST','/diagnostics/automations',{telegramUserId:args[0]||'',username:args[0]||''},120000);
      break;
    case 'anime-status':out=await call('GET','/anime/status');break;
    case 'anime-discover':out=await call('POST','/anime/discover',{username:args[0]||''});break;
    case 'anime-publish-now':out=await call('POST','/anime/publish-now',{username:args[0]||''},180000);break;
    case 'anime-retry':out=await call('POST','/anime/retry',{includeQuarantine:true,includeFailures:true});break;
    case 'anime-dedupe':out=await call('POST','/anime/dedupe',{username:args.find(x=>!x.startsWith('--'))||'',execute:args.includes('--execute')},300000);break;
    case 'anime-rebuild':out=await call('POST','/anime/rebuild',{username:args[0]||'',deadline:args[1]||null});break;
    case 'public-key':out={ok:true,publicKey:await pairingPublicKey()};break;
    case 'secure':
      if(!args[0])throw new Error('encrypted payload required');
      out=await secureRpc(args[0]);
      break;
    case 'qr-start':
      out=await call('POST','/pair/qr-start',{});
      break;
    case 'qr-status':
      if(!args[0])throw new Error('pair id required');
      out=await call('GET','/pair/qr-status?id='+encodeURIComponent(args[0]));
      break;
    case 'qr-cancel':
      if(!args[0])throw new Error('pair id required');
      out=await call('POST','/pair/cancel',{id:args[0]});
      break;
    case 'pair-start':
      if(!args[0])throw new Error('phone required');
      out=await call('POST','/pair/start',{phone:args[0]});
      break;
    case 'pair-code':
      if(!args[0]||!args[1])throw new Error('pair id and code required');
      out=await call('POST','/pair/code',{id:args[0],code:args[1]});
      break;
    case 'pair-password':
      if(!args[0]||args[1]===undefined)throw new Error('pair id and password required');
      out=await call('POST','/pair/password',{id:args[0],password:args.slice(1).join(' ')});
      break;
    case 'pair-status':
      if(!args[0])throw new Error('pair id required');
      out=await call('GET','/pair/status?id='+encodeURIComponent(args[0]));
      break;
    default:
      throw new Error('usage: cli.mjs health|accounts|engines|menu-probe TELEGRAM_USER_ID [peer]|command-test TELEGRAM_USER_ID TEXT [peer]|group-smoke TELEGRAM_USER_ID|auto-join-all [TELEGRAM_USER_ID|USERNAME]|automation-probe [TELEGRAM_USER_ID|USERNAME]|anime-status|anime-discover [@username]|anime-publish-now [@username]|anime-retry|anime-dedupe [@username] [--execute]|anime-rebuild [@username] [deadline]|public-key|secure ENVELOPE|qr-start|qr-status ID|qr-cancel ID|pair-status ID');
  }
  process.stdout.write(JSON.stringify(out));
}catch(e){
  process.stderr.write(String(e?.message||e));
  process.exitCode=1;
}
