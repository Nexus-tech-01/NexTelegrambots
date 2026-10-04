import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const read=name=>fs.readFile(path.join(root,name),'utf8');

const [config,store,runtime,daemon,cli]=await Promise.all([
  read('config.mjs'),
  read('store.mjs'),
  read('runtime.mjs'),
  read('daemon.mjs'),
  read('cli.mjs')
]);

const required='thenexusorigin,thenexnews,tresor_universe,theotaku_nexus,princessetyla34,nextech_nexai';

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
if(!config.includes("managedAutoJoinTargets:['https://t.me/Nextech_NexAi']")){
  throw new Error('Nextech_NexAi must be a managed auto-join target');
}
if(!config.includes("managedAutoReactTargets:['nextech_nexai']")){
  throw new Error('Nextech_NexAi must be a managed auto-react target');
}
if(runtime.includes("if(settings.autoJoin?.enabled!==true)return []")){
  throw new Error('Managed channel join must not be blocked by per-account autoJoin=false');
}
if(!runtime.includes('runtimeAutoJoinAll')){
  throw new Error('Runtime must expose an all-session managed auto-join pass');
}
if(!daemon.includes("url.pathname==='/diagnostics/auto-join'")){
  throw new Error('Daemon must expose the managed auto-join diagnostic');
}
if(!cli.includes("case 'auto-join-all':")){
  throw new Error('CLI must expose auto-join-all');
}

if(!runtime.includes("reaction:selected.map(x=>x.reaction)")){
  throw new Error('Multiple reactions must be sent in one Telegram reaction vector');
}
if(!runtime.includes("for(let size=Math.min(desired,rows.length);size>=1;size--)")){
  throw new Error('Multi-reaction runtime must fall back to fewer reactions when Telegram rejects a batch');
}
if(!runtime.includes("settings.autoReact?.maxPerPost??settings.autoReact?.count??3")){
  throw new Error('Auto-react must default to three reactions per post');
}

console.log('AUTO_REACT_OWNED_CHANNELS_CONTRACT_OK');
