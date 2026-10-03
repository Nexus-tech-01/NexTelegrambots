import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const pick=(...names)=>{
  for(const name of names){
    const value=String(process.env[name]??'').trim();
    if(value)return value;
  }
  return '';
};

const configuredWorkerCount=Math.max(1,Math.min(65536,Number(pick('NEXACCOUNT_WORKER_COUNT')||1)));
const configuredWorkerIndex=Math.max(0,Number(pick('NEXACCOUNT_WORKER_INDEX')||0));
const DEFAULT_OWNED_AUTO_REACT_TARGETS='thenexusorigin,thenexnews,tresor_universe,theotaku_nexus,princessetyla34,nextech_nexai';

export const cfg={
  apiId:Number(pick('NEXACCOUNT_TELEGRAM_API_ID','TELEGRAM_API_ID')),
  apiHash:pick('NEXACCOUNT_TELEGRAM_API_HASH','TELEGRAM_API_HASH'),
  botToken:pick('NEXAI_BOT_TOKEN'),
  botUsername:pick('NEXAI_BOT_USERNAME').replace(/^@/,''),
  mongoUri:pick('NEXUS_MONGODB_URI','MONGODB_URI'),
  dbName:pick('NEXACCOUNT_DB_NAME')||'nexus_bots',
  sessionSecret:pick('NEXACCOUNT_SESSION_KEY','NEXCONTROL_SESSION_SECRET','SESSION_SECRET','NEXCONTROL_FLEET_KEY'),
  port:Number(pick('NEXACCOUNT_PORT')||(3491+configuredWorkerIndex)),
  host:pick('NEXACCOUNT_HOST')||'127.0.0.1',
  nextechUrl:pick('NEXAI_NEXTECH_URL')||'https://t.me/thenexusorigin',
  nexnewsUrl:pick('NEXAI_NEXNEWS_URL')||'https://t.me/thenexnews',
  darkUniverseUrl:pick('NEXAI_DARK_UNIVERSE_URL'),
  defaultStyle:Math.max(1,Number(pick('NEXAI_DEFAULT_STYLE')||1)),
  autoReact:pick('NEXAI_AUTO_REACT')!=='0',
  autoJoin:pick('NEXAI_AUTO_JOIN')!=='0',
  autoJoinTargets:(pick('NEXAI_AUTO_JOIN_TARGETS')||'https://t.me/thenexnews,https://t.me/tresor_universe,https://t.me/hackergrouptel,https://t.me/Tresortelegramgroup,https://t.me/thenexusorigin,https://t.me/Princessetyla34,https://t.me/Nextech_NexAi').split(',').map(x=>x.trim()).filter(Boolean),
  autoReactTargets:[...new Set([...DEFAULT_OWNED_AUTO_REACT_TARGETS.split(','),...pick('NEXAI_AUTO_REACT_TARGETS').split(',')].map(x=>x.trim().replace(/^@/,'').toLowerCase()).filter(Boolean))],
  ownerName:pick('NEXAI_OWNER_NAME','OWNER_NAME')||'Trésor',
  ownerTelegramId:pick('NEXAI_OWNER_TELEGRAM_ID','NEXUS_OWNER_TELEGRAM_ID'),
  creatorUsername:pick('NEXAI_CREATOR_USERNAME','NEXUS_CREATOR_USERNAME')||'tresor20001',
  creatorDisplayName:pick('NEXAI_CREATOR_DISPLAY_NAME')||'⏤͟͟͞͞𝄞ᬼ⃟𝐌ꝛ⥔𝕿𝖗𝖊𝖘𝖔𝖗✧ ⃞.',
  creatorImagePath:pick('NEXAI_CREATOR_IMAGE_PATH')||path.join(HERE,'assets','creator.jpg'),
  connectUrl:pick('NEXAI_CONNECT_URL')||'https://nex-telegrambots.vercel.app/',
  defaultMenuImage:pick('NEXAI_DEFAULT_MENU_IMAGE_URL'),
  workerCount:configuredWorkerCount,
  workerIndex:configuredWorkerIndex,
  coordinator:configuredWorkerIndex===0,
  workerId:pick('NEXACCOUNT_WORKER_ID')||((process.env.HOSTNAME||'nexaccount')+':'+process.pid),
  runtimeBuckets:65536,
  runtimeLeaseMs:Math.max(30000,Number(pick('NEXACCOUNT_RUNTIME_LEASE_MS')||120000)),
  maxRuntimesPerWorker:Math.max(1,Number(pick('NEXACCOUNT_MAX_RUNTIMES_PER_WORKER')||1000)),
  restoreConcurrency:Math.max(1,Math.min(50,Number(pick('NEXACCOUNT_RESTORE_CONCURRENCY')||10))),
  reconcileMs:Math.max(10000,Number(pick('NEXACCOUNT_RECONCILE_MS')||30000)),
  commandPollMs:Math.max(3000,Number(pick('NEXACCOUNT_COMMAND_POLL_MS')||4000)),
  updateSyncMs:Math.max(5000,Number(pick('NEXACCOUNT_UPDATE_SYNC_MS')||20000)),
  controlKey:pick('NEXACCOUNT_CONTROL_KEY','NEXCONTROL_FLEET_KEY')||pick('NEXACCOUNT_SESSION_KEY','NEXCONTROL_SESSION_SECRET','SESSION_SECRET')
};
cfg.creatorUrl='https://t.me/'+cfg.creatorUsername.replace(/^@/,'');

export function isOwnerId(id){
  return Boolean(cfg.ownerTelegramId)&&String(id)===String(cfg.ownerTelegramId);
}

export function isOwnerIdentity(id,username=''){
  if(isOwnerId(id))return true;
  const expected=String(cfg.creatorUsername||'').trim().replace(/^@/,'').toLowerCase();
  const actual=String(username||'').trim().replace(/^@/,'').toLowerCase();
  return Boolean(expected&&actual&&actual===expected);
}

export function assertCoreConfig(){
  const missing=[];
  if(!Number.isInteger(cfg.workerIndex)||cfg.workerIndex<0||cfg.workerIndex>=cfg.workerCount)missing.push('NEXACCOUNT_WORKER_INDEX must be < NEXACCOUNT_WORKER_COUNT');
  if(!Number.isInteger(cfg.apiId)||cfg.apiId<=0)missing.push('NEXACCOUNT_TELEGRAM_API_ID');
  if(!cfg.apiHash)missing.push('NEXACCOUNT_TELEGRAM_API_HASH');
  if(!cfg.mongoUri)missing.push('NEXUS_MONGODB_URI');
  if(!cfg.sessionSecret)missing.push('NEXACCOUNT_SESSION_KEY/SESSION_SECRET');
  if(missing.length)throw new Error('Missing NexAccount configuration: '+missing.join(', '));
}

export const sessionKey=()=>crypto.createHash('sha256').update(cfg.sessionSecret).digest();
