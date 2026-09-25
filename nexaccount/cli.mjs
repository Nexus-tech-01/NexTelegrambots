import { decryptPairingEnvelope, pairingPublicKey } from './secure-rpc.mjs';

const workerIndex=Math.max(0,Number(process.env.NEXACCOUNT_WORKER_INDEX||0));
const port=Number(process.env.NEXACCOUNT_PORT||(3491+workerIndex));
const base='http://127.0.0.1:'+port;
const controlKey=String(process.env.NEXACCOUNT_CONTROL_KEY||process.env.NEXCONTROL_FLEET_KEY||process.env.NEXACCOUNT_SESSION_KEY||process.env.NEXCONTROL_SESSION_SECRET||process.env.SESSION_SECRET||'').trim();

async function call(method,path,payload){
  const r=await fetch(base+path,{
    method,
    headers:{...(payload?{'content-type':'application/json'}:{}),...(controlKey?{'x-nexaccount-key':controlKey}:{})},
    body:payload?JSON.stringify(payload):undefined,
    signal:AbortSignal.timeout(30000)
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
    case 'menu-probe':
      if(!args[0])throw new Error('telegram user id required');
      out=await call('POST','/diagnostics/menu',{telegramUserId:args[0],peer:args[1]||'me'});
      break;
    case 'anime-status':out=await call('GET','/anime/status');break;
    case 'anime-discover':out=await call('POST','/anime/discover',{username:args[0]||''});break;
    case 'anime-retry':out=await call('POST','/anime/retry',{includeQuarantine:true,includeFailures:true});break;
    case 'anime-rebuild':out=await call('POST','/anime/rebuild',{username:args[0]||'',deadline:args[1]||null});break;
    case 'public-key':out={ok:true,publicKey:await pairingPublicKey()};break;
    case 'secure':
      if(!args[0])throw new Error('encrypted payload required');
      out=await secureRpc(args[0]);
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
      throw new Error('usage: cli.mjs health|accounts|engines|menu-probe TELEGRAM_USER_ID [peer]|anime-status|anime-discover [@username]|anime-retry|anime-rebuild [@username] [deadline]|public-key|secure ENVELOPE|pair-status ID');
  }
  process.stdout.write(JSON.stringify(out));
}catch(e){
  process.stderr.write(String(e?.message||e));
  process.exitCode=1;
}
