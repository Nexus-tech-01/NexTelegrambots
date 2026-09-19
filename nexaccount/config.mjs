import crypto from 'node:crypto';

const pick=(...names)=>{
  for(const name of names){
    const value=String(process.env[name]??'').trim();
    if(value)return value;
  }
  return '';
};

export const cfg={
  apiId:Number(pick('NEXACCOUNT_TELEGRAM_API_ID','NEXGROUP__TELEGRAM_API_ID','TELEGRAM_API_ID')),
  apiHash:pick('NEXACCOUNT_TELEGRAM_API_HASH','NEXGROUP__TELEGRAM_API_HASH','TELEGRAM_API_HASH'),
  botToken:pick('NEXAI_BOT_TOKEN'),
  botUsername:pick('NEXAI_BOT_USERNAME').replace(/^@/,''),
  mongoUri:pick('NEXUS_MONGODB_URI','MONGODB_URI'),
  dbName:pick('NEXACCOUNT_DB_NAME')||'nexus_bots',
  sessionSecret:pick('NEXACCOUNT_SESSION_KEY','NEXCONTROL_SESSION_SECRET','SESSION_SECRET','NEXCONTROL_FLEET_KEY'),
  port:Number(pick('NEXACCOUNT_PORT')||3491),
  host:pick('NEXACCOUNT_HOST')||'127.0.0.1',
  nextechUrl:pick('NEXAI_NEXTECH_URL')||'https://t.me/thenexusorigin',
  nexnewsUrl:pick('NEXAI_NEXNEWS_URL')||'https://t.me/thenexnews',
  darkUniverseUrl:pick('NEXAI_DARK_UNIVERSE_URL'),
  defaultStyle:Math.max(1,Number(pick('NEXAI_DEFAULT_STYLE')||1)),
  autoReact:pick('NEXAI_AUTO_REACT')!=='0',
  autoJoin:pick('NEXAI_AUTO_JOIN')!=='0',
  ownerName:pick('NEXAI_OWNER_NAME','OWNER_NAME')||'Trésor',
  defaultMenuImage:pick('NEXAI_DEFAULT_MENU_IMAGE_URL')
};

export function assertCoreConfig(){
  const missing=[];
  if(!Number.isInteger(cfg.apiId)||cfg.apiId<=0)missing.push('NEXACCOUNT_TELEGRAM_API_ID');
  if(!cfg.apiHash)missing.push('NEXACCOUNT_TELEGRAM_API_HASH');
  if(!cfg.mongoUri)missing.push('NEXUS_MONGODB_URI');
  if(!cfg.sessionSecret)missing.push('NEXACCOUNT_SESSION_KEY/SESSION_SECRET');
  if(missing.length)throw new Error('Missing NexAccount configuration: '+missing.join(', '));
}

export const sessionKey=()=>crypto.createHash('sha256').update(cfg.sessionSecret).digest();
