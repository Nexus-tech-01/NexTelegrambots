import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const read=name=>fs.readFile(path.join(root,name),'utf8');

const [config,store,runtime]=await Promise.all([
  read('config.mjs'),
  read('store.mjs'),
  read('runtime.mjs')
]);

const required='thenexusorigin,thenexnews,tresor_universe,theotaku_nexus,princessetyla34';

if(!config.includes(required)){
  throw new Error('Auto-react owned-channel allowlist is missing from config');
}
if(config.includes("autoReactTargets:(pick('NEXAI_AUTO_REACT_TARGETS')||'*')")){
  throw new Error('Auto-react wildcard default must never be restored');
}
if(store.includes("autoReact:{enabled:true,mode:'smart',targets:['*']")){
  throw new Error('New accounts must never receive wildcard auto-react targets');
}
if(!runtime.includes('safeAutoReactTargets')){
  throw new Error('Runtime must enforce the owned-channel auto-react allowlist');
}
if(!runtime.includes('...configured,...explicit')){
  throw new Error('Runtime must merge configured targets into existing account settings');
}
if(runtime.includes('wildcard&&isBroadcastChannel')){
  throw new Error('Runtime must never auto-react to arbitrary joined broadcast channels');
}

console.log('AUTO_REACT_OWNED_CHANNELS_CONTRACT_OK');
