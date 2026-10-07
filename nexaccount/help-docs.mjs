import crypto from 'node:crypto';
import { cfg } from './config.mjs';
import { commandMap } from './commands.mjs';
import { db } from './store.mjs';
import { loadBotToken } from './secrets.mjs';

const COLLECTION='nexai_help_docs';
const DEFAULT_CHANNEL='Nextech_NexAi';

const CATEGORY_FR={
  GENERAL:'Général',ACCOUNT:'Compte',AI:'IA',DOWNLOAD:'Téléchargement',GROUP:'Groupe',
  SHIELD:'Protection',TOOLS:'Outils',MEDIA:'Média',STICKER:'Stickers',GAMES:'Jeux',
  SEARCH:'Recherche',ANIME:'Anime',PREMIUM:'NexAI Premium',OWNER:'Propriétaire'
};
const CATEGORY_EN={
  GENERAL:'General',ACCOUNT:'Account',AI:'AI',DOWNLOAD:'Download',GROUP:'Group',
  SHIELD:'Protection',TOOLS:'Tools',MEDIA:'Media',STICKER:'Stickers',GAMES:'Games',
  SEARCH:'Search',ANIME:'Anime',PREMIUM:'NexAI Premium',OWNER:'Owner'
};

const EN_EXACT={
  menu:'Open the main NexAI menu.',
  help:'Open command help.',
  ping:'Measure the NexAI engine latency.',
  alive:'Check whether NexAI is online.',
  creator:'Show information about the NexAI creator.',
  style:'Show or change the interface style.',
  support:'Open NexAI support information.',
  repo:'Show the Nextech project information.',
  account:'Show information about the connected Telegram account.',
  pair:'Connect a Telegram account.',
  sessions:'Show connected sessions.',
  dashboard:'Open the account dashboard.',
  settings:'Open NexAI settings.',
  stats:'Show account statistics.',
  premium:'Show Telegram Premium and NexAI Premium status.',
  prefix:'Change the command prefix.',
  mode:'Change private/public access mode.',
  language:'Change the interface language.',
  device:'Show session/device information.',
  autoreact:'Enable or disable automatic reactions.',
  autoreply:'Configure automatic replies.',
  reply:'Enable the video-note reply sent when the connected account is mentioned.',
  setreply:'Set the mention reply by replying to a video note.',
  aimode:'Enable natural AI conversation mode.',
  presence:'Configure account presence.',
  autotyping:'Configure the automatic typing indicator.',
  botname:'Change the name displayed in the menu.',
  customstyle:'Enable, disable or reset the personal style.',
  stylename:'Change the personal style name.',
  styleemoji:'Change the personal style emojis.',
  styletagline:'Change the personal style tagline.',
  stylebuttons:'Change the menu button style.',
  menuphoto:'Use the replied photo as menu media.',
  menuvideo:'Use the replied video as menu media.',
  menumedia:'Disable personal menu media.',
  menuimage:'Change the menu illustration.',
  menuemoji:'Configure custom menu emojis.',
  ai:'Use the AI assistant.',
  code:'Get programming help.',
  deepseek:'Use deep reasoning mode.',
  song:'Search for or download music.',
  video:'Download a YouTube video.',
  download:'Download media from a supported link.',
  tiktok:'Download TikTok media.',
  instagram:'Download Instagram media.',
  facebook:'Download Facebook media.',
  pinterest:'Download Pinterest media.',
  snapchat:'Download Snapchat Spotlight or Story media.',
  capcut:'Download CapCut media.',
  twitter:'Download X / Twitter media.',
  reddit:'Download Reddit media.',
  soundcloud:'Download SoundCloud media.',
  vimeo:'Download Vimeo media.',
  tumblr:'Download Tumblr media.',
  tomp3:'Convert a video to MP3.',
  lyrics:'Find song lyrics.',
  shazam:'Identify a song.',
  apk:'Search for an APK.',
  downloadinfo:'Inspect a download URL.'
};

const ARG_HINTS={
  help:'<command>',
  language:'fr | en',
  prefix:'<prefix>',
  mode:'private | public',
  botname:'<name>',
  stylename:'<name>',
  styleemoji:'<emoji...>',
  styletagline:'<text>',
  stylebuttons:'primary | success | danger',
  customstyle:'on | off | reset',
  ai:'<question>',
  code:'<request>',
  deepseek:'<question>',
  song:'<title or URL>',
  video:'<URL>',
  download:'<URL>',
  tiktok:'<URL>',
  instagram:'<URL>',
  facebook:'<URL>',
  pinterest:'<URL>',
  snapchat:'<URL>',
  capcut:'<URL>',
  twitter:'<URL>',
  reddit:'<URL>',
  soundcloud:'<URL>',
  vimeo:'<URL>',
  tumblr:'<URL>',
  tomp3:'<URL>',
  lyrics:'<song>',
  shazam:'<audio or replied media>',
  apk:'<app name>',
  translate:'<language> <text>',
  calc:'<expression>',
  weather:'<city>',
  user:'<user id or @username>'
};

function lang(value){
  return String(value||'fr').toLowerCase().startsWith('en')?'en':'fr';
}

function cleanName(value){
  return String(value||'').trim().replace(/^[/!.]+/,'').toLowerCase();
}

function channelUsername(){
  return String(cfg.helpChannelUsername||DEFAULT_CHANNEL).trim().replace(/^@/,'')||DEFAULT_CHANNEL;
}

function esc(value){
  return String(value??'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

function sleep(ms){
  return new Promise(resolve=>setTimeout(resolve,ms));
}

function englishDescription(cmd){
  const name=String(cmd?.name||'').toLowerCase();
  if(EN_EXACT[name])return EN_EXACT[name];
  const fr=String(cmd?.description||'').trim();
  const rules=[
    [/^Télécharger\s+/i,'Download '],
    [/^Rechercher\s+/i,'Search '],
    [/^Afficher\s+/i,'Show '],
    [/^Changer\s+/i,'Change '],
    [/^Configurer\s+/i,'Configure '],
    [/^Créer\s+/i,'Create '],
    [/^Supprimer\s+/i,'Delete '],
    [/^Activer\/désactiver\s+/i,'Enable/disable '],
    [/^Activer\s+/i,'Enable '],
    [/^Désactiver\s+/i,'Disable '],
    [/^Convertir\s+/i,'Convert '],
    [/^Identifier\s+/i,'Identify '],
    [/^Statistiques\s+/i,'Statistics for ']
  ];
  for(const [re,prefix] of rules){
    if(re.test(fr)){
      const tail=fr.replace(re,'').replace(/\.$/,'');
      if(/^[\x00-\x7F\s/·:+()_-]+$/.test(tail))return prefix+tail+'.';
      break;
    }
  }
  const category=CATEGORY_EN[String(cmd?.category||'').toUpperCase()]||'NexAI';
  return category+' command: /'+name+'.';
}

function canonicalRegistry(){
  const map=commandMap();
  const canonical=new Map();
  const aliases=new Map();
  for(const [token,raw] of map.entries()){
    const key=cleanName(token);
    const canonicalName=cleanName(raw?.aliasFor||raw?.name||token);
    if(!key||!canonicalName)continue;
    if(key!==canonicalName){
      const list=aliases.get(canonicalName)||[];
      if(!list.includes(key))list.push(key);
      aliases.set(canonicalName,list);
    }
    const candidate={...raw,name:canonicalName};
    const previous=canonical.get(canonicalName);
    if(!previous||!raw?.aliasFor)canonical.set(canonicalName,candidate);
  }
  for(const [name,list] of aliases)list.sort((a,b)=>a.localeCompare(b));
  return {map,canonical,aliases};
}

function resolveCommand(name){
  const token=cleanName(name);
  if(!token)return null;
  const {map,canonical,aliases}=canonicalRegistry();
  const raw=map.get(token);
  if(!raw)return null;
  const canonicalName=cleanName(raw?.aliasFor||raw?.name||token);
  const cmd=canonical.get(canonicalName)||{...raw,name:canonicalName};
  return {cmd,canonicalName,aliases:aliases.get(canonicalName)||[]};
}

function contextLabel(cmd,l){
  if(cmd?.privateOnly)return l==='en'?'Private chat only':'Privé uniquement';
  if(cmd?.groupOnly)return l==='en'?'Groups only':'Groupes uniquement';
  return l==='en'?'Private chats and groups':'Privé et groupes';
}

function accessLabels(cmd,l){
  const out=[];
  if(cmd?.ownerOnly)out.push(l==='en'?'NexAI owner/admin':'Propriétaire/admin NexAI');
  if(cmd?.adminOnly)out.push(l==='en'?'Group administrator':'Administrateur du groupe');
  if(cmd?.selfOnly)out.push(l==='en'?'Connected account':'Compte connecté');
  if(cmd?.nexaiPremium)out.push('NexAI Premium');
  if(cmd?.telegramPremium||cmd?.premium)out.push('Telegram Premium');
  if(!out.length)out.push(l==='en'?'Standard access':'Accès standard');
  return out.join(' · ');
}

function usageFor(cmd){
  const name=String(cmd?.name||'').toLowerCase();
  const hint=ARG_HINTS[name]||'[arguments]';
  return '/'+name+(hint?' '+hint:'');
}

function exampleFor(cmd){
  const name=String(cmd?.name||'').toLowerCase();
  const hint=ARG_HINTS[name]||'';
  if(!hint)return '/'+name;
  return '/'+name+' '+hint
    .replace('<command>','ping')
    .replace('<prefix>','!')
    .replace('<name>','NexAI')
    .replace('<question>','Explain recursion simply')
    .replace('<request>','Create a JavaScript debounce function')
    .replace('<title or URL>','Imagine Dragons Believer')
    .replace('<URL>','https://example.com/media')
    .replace('<language>','en')
    .replace('<text>','bonjour')
    .replace('<expression>','2+2')
    .replace('<city>','Cotonou')
    .replace('<song>','Believer')
    .replace('<app name>','Telegram')
    .replace('<user id or @username>','@username')
    .replace('<emoji...>','✨ ⚡')
    .replace('<audio or replied media>','[reply to audio]');
}

function renderCard(cmd,l,aliases=[]){
  const name=String(cmd.name||'').toLowerCase();
  const isEn=l==='en';
  const category=(isEn?CATEGORY_EN:CATEGORY_FR)[String(cmd.category||'').toUpperCase()]||String(cmd.category||'NexAI');
  const description=isEn?englishDescription(cmd):String(cmd.description||('Commande NexAI /'+name+'.'));
  const aliasText=aliases.length?aliases.map(a=>'/'+a).join(', '):(isEn?'None':'Aucun');
  const engine=String(cmd.engine||cmd.handler||'native');
  const usage=usageFor(cmd);
  const example=exampleFor(cmd);
  if(isEn){
    return [
      '<b>⛩ NEXAI · /'+esc(name)+'</b>',
      '',
      '<blockquote>'+esc(description)+'</blockquote>',
      '',
      '<b>Category</b> · '+esc(category),
      '<b>Usage</b> · <code>'+esc(usage)+'</code>',
      '<b>Example</b> · <code>'+esc(example)+'</code>',
      '<b>Aliases</b> · '+esc(aliasText),
      '<b>Context</b> · '+esc(contextLabel(cmd,l)),
      '<b>Access</b> · '+esc(accessLabels(cmd,l)),
      '<b>Engine</b> · '+esc(engine),
      '',
      'Use <code>/help '+esc(name)+'</code> anytime to reopen this guide.',
      '<i>Official NexAI command documentation · English</i>'
    ].join('\n');
  }
  return [
    '<b>⛩ NEXAI · /'+esc(name)+'</b>',
    '',
    '<blockquote>'+esc(description)+'</blockquote>',
    '',
    '<b>Catégorie</b> · '+esc(category),
    '<b>Utilisation</b> · <code>'+esc(usage)+'</code>',
    '<b>Exemple</b> · <code>'+esc(example)+'</code>',
    '<b>Alias</b> · '+esc(aliasText),
    '<b>Contexte</b> · '+esc(contextLabel(cmd,l)),
    '<b>Accès</b> · '+esc(accessLabels(cmd,l)),
    '<b>Moteur</b> · '+esc(engine),
    '',
    'Utilise <code>/help '+esc(name)+'</code> à tout moment pour rouvrir cette fiche.',
    '<i>Documentation officielle des commandes NexAI · Français</i>'
  ].join('\n');
}

function hashText(value){
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function telegramCall(token,method,payload,{attempts=8}={}){
  let lastError=null;
  for(let attempt=0;attempt<attempts;attempt++){
    try{
      const response=await fetch('https://api.telegram.org/bot'+token+'/'+method,{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify(payload),
        signal:AbortSignal.timeout(15000)
      });
      const data=await response.json().catch(()=>({}));
      if(response.ok&&data?.ok===true)return data.result;
      const retryAfter=Math.max(0,Number(data?.parameters?.retry_after||0));
      const description=String(data?.description||('HTTP '+response.status));
      if(retryAfter>0){
        await sleep((retryAfter+1)*1000);
        continue;
      }
      if(/message is not modified/i.test(description))return {notModified:true};
      throw new Error(description);
    }catch(error){
      lastError=error;
      if(attempt+1>=attempts)break;
      await sleep(Math.min(5000,500*(attempt+1)));
    }
  }
  throw lastError||new Error('Telegram API request failed');
}

async function storedDoc(name,l){
  const d=await db();
  return d.collection(COLLECTION).findOne({_id:l+':'+name});
}

async function saveDoc(name,l,data){
  const d=await db();
  const now=new Date();
  await d.collection(COLLECTION).updateOne(
    {_id:l+':'+name},
    {$set:{...data,name,language:l,updatedAt:now},$setOnInsert:{createdAt:now}},
    {upsert:true}
  );
}

export function helpChannelUrl(){
  return 'https://t.me/'+channelUsername();
}

export async function syncOneHelpDoc(inputName,inputLang='fr'){
  const l=lang(inputLang);
  const resolved=resolveCommand(inputName);
  if(!resolved)return {ok:false,error:'unknown_command',name:cleanName(inputName),language:l};
  const {cmd,canonicalName,aliases}=resolved;
  const token=await loadBotToken();
  if(!token)return {ok:false,error:'bot_token_missing',name:canonicalName,language:l};

  const channel=channelUsername();
  const text=renderCard(cmd,l,aliases);
  const hash=hashText(text);
  const existing=await storedDoc(canonicalName,l).catch(()=>null);
  let messageId=Number(existing?.messageId||0);

  if(existing?.hash===hash&&messageId>0&&String(existing?.channelUsername||'').toLowerCase()===channel.toLowerCase()){
    return {ok:true,changed:false,name:canonicalName,language:l,messageId,url:'https://t.me/'+channel+'/'+messageId};
  }

  if(messageId>0&&String(existing?.channelUsername||'').toLowerCase()===channel.toLowerCase()){
    try{
      await telegramCall(token,'editMessageText',{
        chat_id:'@'+channel,
        message_id:messageId,
        text,
        parse_mode:'HTML',
        disable_web_page_preview:true
      });
      await saveDoc(canonicalName,l,{channelUsername:channel,messageId,hash,textVersion:1});
      return {ok:true,changed:true,edited:true,name:canonicalName,language:l,messageId,url:'https://t.me/'+channel+'/'+messageId};
    }catch(error){
      const reason=String(error?.message||error);
      if(!/message to edit not found|chat not found|message_id_invalid/i.test(reason))throw error;
    }
  }

  const sent=await telegramCall(token,'sendMessage',{
    chat_id:'@'+channel,
    text,
    parse_mode:'HTML',
    disable_web_page_preview:true
  });
  messageId=Number(sent?.message_id||0);
  if(!messageId)throw new Error('Telegram did not return a message_id');
  await saveDoc(canonicalName,l,{channelUsername:channel,messageId,hash,textVersion:1});
  return {ok:true,changed:true,created:true,name:canonicalName,language:l,messageId,url:'https://t.me/'+channel+'/'+messageId};
}

export async function syncHelpDocs({languages=['fr','en'],names=null}={}){
  const registry=canonicalRegistry();
  const requested=Array.isArray(names)&&names.length
    ?names.map(cleanName).filter(Boolean)
    :[...registry.canonical.keys()].sort((a,b)=>a.localeCompare(b));
  const unique=[...new Set(requested)];
  const stats={ok:true,total:0,created:0,edited:0,unchanged:0,failed:0,errors:[]};
  for(const name of unique){
    for(const requestedLang of languages){
      stats.total++;
      try{
        const result=await syncOneHelpDoc(name,requestedLang);
        if(!result.ok){
          stats.failed++;
          stats.errors.push({name,language:lang(requestedLang),error:result.error});
        }else if(result.created)stats.created++;
        else if(result.edited)stats.edited++;
        else stats.unchanged++;
      }catch(error){
        stats.failed++;
        stats.errors.push({name,language:lang(requestedLang),error:String(error?.message||error).slice(0,300)});
      }
      await sleep(Math.max(50,Number(cfg.helpSyncDelayMs)||250));
    }
  }
  stats.ok=stats.failed===0;
  return stats;
}

export async function helpDocLink(inputName,inputLang='fr',{ensure=true}={}){
  const l=lang(inputLang);
  const resolved=resolveCommand(inputName);
  if(!resolved)return {ok:false,error:'unknown_command',language:l,name:cleanName(inputName)};
  const name=resolved.canonicalName;
  const channel=channelUsername();
  let row=await storedDoc(name,l).catch(()=>null);
  if((!row?.messageId||String(row?.channelUsername||'').toLowerCase()!==channel.toLowerCase())&&ensure){
    const synced=await syncOneHelpDoc(name,l);
    if(!synced.ok)return synced;
    return synced;
  }
  const messageId=Number(row?.messageId||0);
  if(!messageId)return {ok:false,error:'help_doc_missing',name,language:l};
  return {ok:true,name,language:l,messageId,url:'https://t.me/'+channel+'/'+messageId};
}

export function helpCommandExists(name){
  return Boolean(resolveCommand(name));
}
