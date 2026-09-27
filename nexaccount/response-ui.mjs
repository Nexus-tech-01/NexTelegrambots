import { Api } from 'teleproto';
import { cfg } from './config.mjs';
import { patchSettings, settingsFor } from './store.mjs';

const utf16len=s=>Buffer.from(String(s),'utf16le').length/2;
const clean=v=>String(v??'').trim();

const PREMIUM_EMOJI_GLYPHS={
  WAIT:'⏳',CHECK:'✅',ERROR:'❌',
  GENERAL:'🏠',ACCOUNT:'👤',AI:'🧠',DOWNLOAD:'📥',GROUP:'👥',SHIELD:'🛡️',
  TOOLS:'🛠️',MEDIA:'🎞️',STICKER:'🎴',GAMES:'🎮',SEARCH:'🔎',ANIME:'🌸',
  PREMIUM:'👑',OWNER:'🔮',NEXTECH:'⚡',NEWS:'📰',DARK:'🕯️',BACK:'↩️',
  NEXT:'➡️',STYLE:'🎨'
};
const premiumEmojiAttempts=new Map();
const PREMIUM_EMOJI_RETRY_MS=6*60*60*1000;
const normalizeEmoji=value=>String(value??'').replace(/\uFE0F/g,'').replace(/\u200D/g,'').trim();

function customEmojiAttr(document){
  return (document?.attributes||[]).find(a=>/DocumentAttributeCustomEmoji/i.test(String(a?.className||a?.constructor?.name||a?._||'')))||null;
}

function customEmojiId(document){
  const id=document?.id??document?.documentId??document?.document_id;
  return id==null?'':String(id);
}

function customEmojiEntities(text,customEmojiIds={},logicalKeys=['WAIT','CHECK','ERROR']){
  const value=String(text??'');
  const entities=[];
  for(const logical of logicalKeys){
    const glyph=PREMIUM_EMOJI_GLYPHS[logical];
    const id=String(customEmojiIds?.['NEXAI_EMOJI_'+logical]||'').trim();
    if(!glyph||!/^\d{5,30}$/.test(id))continue;
    let from=0;
    while(true){
      const start=value.indexOf(glyph,from);
      if(start<0)break;
      entities.push(new Api.MessageEntityCustomEmoji({
        offset:utf16len(value.slice(0,start)),
        length:utf16len(glyph),
        documentId:BigInt(id)
      }));
      from=start+glyph.length;
    }
  }
  return entities;
}

export async function ensurePremiumEmojiPalette(client,telegramUserId,{premium=false,keys=null,force=false}={}){
  const accountId=String(telegramUserId||'');
  if(!client||!accountId||premium!==true)return accountId?settingsFor(accountId):null;

  const settings=await settingsFor(accountId);
  const wanted=(Array.isArray(keys)&&keys.length?keys:Object.keys(PREMIUM_EMOJI_GLYPHS))
    .map(v=>String(v||'').toUpperCase())
    .filter(v=>PREMIUM_EMOJI_GLYPHS[v]);

  const missing=wanted.filter(key=>!/^\d{5,30}$/.test(String(settings?.customEmojiIds?.['NEXAI_EMOJI_'+key]||'')));
  if(!missing.length)return settings;

  const cacheKey=accountId+':'+missing.sort().join(',');
  const last=premiumEmojiAttempts.get(cacheKey)||0;
  if(!force&&Date.now()-last<PREMIUM_EMOJI_RETRY_MS)return settings;
  premiumEmojiAttempts.set(cacheKey,Date.now());

  const Search=Api.messages?.SearchCustomEmoji;
  const GetDocs=Api.messages?.GetCustomEmojiDocuments;
  if(typeof Search!=='function'||typeof GetDocs!=='function'){
    console.warn('[NexAccount premium-emoji] Telegram library has no custom-emoji search API');
    return settings;
  }

  const candidates=new Map();
  const allIds=new Set();
  for(const key of missing){
    const glyph=PREMIUM_EMOJI_GLYPHS[key];
    try{
      const result=await client.invoke(new Search({emoticon:glyph,hash:BigInt(0)}));
      const ids=(result?.documentId||result?.document_id||result?.documents||result?.ids||[])
        .map(v=>String(v))
        .filter(v=>/^\d{5,30}$/.test(v))
        .slice(0,8);
      if(ids.length){
        candidates.set(key,{glyph,ids});
        ids.forEach(id=>allIds.add(id));
      }
    }catch(error){
      console.warn('[NexAccount premium-emoji] search',key,String(error?.errorMessage||error?.message||error).slice(0,180));
    }
  }

  if(!allIds.size)return settings;

  let docs=[];
  try{
    docs=await client.invoke(new GetDocs({documentId:[...allIds].map(id=>BigInt(id))}));
  }catch(error){
    console.warn('[NexAccount premium-emoji] documents',String(error?.errorMessage||error?.message||error).slice(0,200));
    return settings;
  }
  const list=Array.isArray(docs)?docs:(docs?.documents||[]);
  const byId=new Map(list.map(doc=>[customEmojiId(doc),doc]));
  const current={...(settings.customEmojiIds||{})};
  let changed=false;

  for(const [key,{glyph,ids}] of candidates){
    const expected=normalizeEmoji(glyph);
    let selected='';
    for(const id of ids){
      const doc=byId.get(id);
      const alt=normalizeEmoji(customEmojiAttr(doc)?.alt||'');
      if(doc&&alt===expected){selected=id;break}
    }
    if(!selected)continue;
    current['NEXAI_EMOJI_'+key]=selected;
    changed=true;
  }

  if(!changed)return settings;
  const next=await patchSettings(accountId,{customEmojiIds:current});
  console.log('[NexAccount premium-emoji]',accountId,'auto-configured',Object.keys(next.customEmojiIds||{}).length,'custom emoji');
  return next;
}

export function brandedText(value,{signature=true}={}){
  const base=String(value??'');
  if(!signature||!cfg.nextechUrl)return {text:base,entities:[]};
  const label='By Nextech';
  const cleanBase=base.replace(/\s+$/,'');
  const text=(cleanBase?cleanBase+'\n\n':'')+label;
  const start=text.lastIndexOf(label);
  return {
    text,
    entities:[new Api.MessageEntityTextUrl({
      offset:utf16len(text.slice(0,start)),
      length:utf16len(label),
      url:cfg.nextechUrl
    })]
  };
}

export async function sendBrandedText(client,peer,value,options={}){
  const branded=brandedText(value,{signature:options.signature!==false});
  const formattingEntities=[
    ...(Array.isArray(options.formattingEntities)?options.formattingEntities:[]),
    ...branded.entities
  ];
  return client.sendMessage(peer,{
    message:branded.text,
    ...options,
    formattingEntities
  });
}

export async function createProgress(client,peer,label='Traitement',options={}){
  const customEmojiIds=options?.customEmojiIds||{};
  const initial='⏳ '+clean(label)+'…';
  const sent=await client.sendMessage(peer,{
    message:initial,
    formattingEntities:customEmojiEntities(initial,customEmojiIds)
  });
  const id=Number(sent?.id||sent?.message?.id||0);
  let inputPeer=null;
  try{inputPeer=await client.getInputEntity(peer)}catch{}
  const edit=async text=>{
    if(!id||!inputPeer)return;
    const value=String(text);
    try{
      await client.invoke(new Api.messages.EditMessage({
        peer:inputPeer,id,message:value,
        entities:customEmojiEntities(value,customEmojiIds)
      }));
    }catch{}
  };
  const state={finished:false};
  return {
    id,
    get finished(){return state.finished},
    update:text=>edit(String(text)),
    step:text=>edit('⏳ '+String(text)),
    async done(text){
      state.finished=true;
      await edit('✅ '+String(text||label+' terminé'));
    },
    async fail(text){
      state.finished=true;
      await edit('❌ '+String(text||label+' impossible'));
    }
  };
}

export function nextechInlineButton(text='NEXTECH'){
  return cfg.nextechUrl?{text:String(text),url:cfg.nextechUrl}:null;
}
