import { decryptPairingEnvelope, pairingPublicKey } from './secure-rpc.mjs';

const port=Number(process.env.NEXACCOUNT_PORT||3491);
const base='http://127.0.0.1:'+port;

async function call(method,path,payload){
  const r=await fetch(base+path,{
    method,
    headers:payload?{'content-type':'application/json'}:undefined,
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
      throw new Error('usage: cli.mjs health|accounts|public-key|secure ENVELOPE|pair-status ID');
  }
  process.stdout.write(JSON.stringify(out));
}catch(e){
  process.stderr.write(String(e?.message||e));
  process.exitCode=1;
}
