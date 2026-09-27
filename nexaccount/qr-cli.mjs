import fs from 'node:fs';

function loadEnvFile(file){
  try{
    const text=fs.readFileSync(file,'utf8');
    for(const raw of text.split(/\r?\n/)){
      const line=raw.trim();
      if(!line||line.startsWith('#'))continue;
      const pos=line.indexOf('=');
      if(pos<1)continue;
      const key=line.slice(0,pos).trim();
      if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||process.env[key]!==undefined)continue;
      let value=line.slice(pos+1).trim();
      if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
      process.env[key]=value;
    }
  }catch{}
}

loadEnvFile(process.env.NEXACCOUNT_ENV_FILE||'/home/container/.env');
loadEnvFile(new URL('./.env',import.meta.url).pathname);

const {assertCoreConfig}=await import('./config.mjs');
const {beginQrPairing,cancelPairing,qrPairingStatus}=await import('./pairing.mjs');
const {closeStore}=await import('./store.mjs');

assertCoreConfig();
const [command,...args]=process.argv.slice(2);

try{
  let out;
  if(command==='qr-start')out=await beginQrPairing();
  else if(command==='qr-status'){
    if(!args[0])throw new Error('pair id required');
    out=await qrPairingStatus(args[0]);
  }else if(command==='qr-cancel'){
    if(!args[0])throw new Error('pair id required');
    out=await cancelPairing(args[0]);
  }else if(command==='health'){
    out={stage:'ready'};
  }else{
    throw new Error('usage: qr-cli.mjs qr-start|qr-status ID|qr-cancel ID|health');
  }

  await closeStore().catch(()=>{});
  process.stdout.write(JSON.stringify({ok:true,...out}));
  setImmediate(()=>process.exit(0));
}catch(error){
  await closeStore().catch(()=>{});
  process.stderr.write(String(error?.message||error));
  setImmediate(()=>process.exit(1));
}