import { Api } from 'teleproto';
import { cfg } from './config.mjs';
import { patchSettings, settingsFor } from './store.mjs';

const utf16len=s=>Buffer.from(String(s),'utf16le').length/2;
const clean=v=>String(v??'').trim();

export const PREMIUM_EMOJI_GLYPHS=Object.freeze({
  WAIT:'⏳',CHECK:'✅',ERROR:'❌',
  GENERAL:'🏠',ACCOUNT:'👤',AI:'🧠',DOWNLOAD:'📥',GROUP:'👥',SHIELD:'🔒',
  TOOLS:'🛠️',MEDIA:'🎞️',STICKER:'🎴',GAMES:'🎮',SEARCH:'🔎',ANIME:'🌸',
  PREMIUM:'👑',OWNER:'🔮',NEXTECH:'⚡',NEWS:'📰',DARK:'🕯️',BACK:'↩️',
  NEXT:'➡️',STYLE:'🎨',LINK:'🔗',LANGUAGE:'🌐',FIRE:'🔥',HEART:'❤️',LIKE:'👍',
  STYLE_1:'🕯',STYLE_2:'🍃',STYLE_3:'🕶️',STYLE_4:'💻',STYLE_5:'⚔️',
  STYLE_6:'⭐',STYLE_7:'🌸',STYLE_8:'👁',STYLE_9:'🌿',STYLE_10:'🎀',
  STYLE_11:'🗡',STYLE_12:'👁',STYLE_13:'🪷',STYLE_14:'👁',STYLE_15:'⚔',
  STYLE_16:'👁',STYLE_17:'👑',STYLE_18:'📊',STYLE_19:'🌒',STYLE_20:'☄',
  STYLE_21:'🌙',STYLE_22:'🦇',STYLE_23:'🌸',STYLE_24:'❄',STYLE_25:'🍫',
  STYLE_26:'⚔',STYLE_27:'⚽',STYLE_28:'🎯',STYLE_29:'🩸',STYLE_30:'🦋',
  STYLE_31:'⛩'
});
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
  const current={...(settings.customEmojiIds||{})};
  let changed=false;
  const candidates=new Map();
  const allIds=new Set();

  if(typeof Search==='function'){
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
  }

  if(allIds.size&&typeof GetDocs==='function'){
    try{
      const docs=await client.invoke(new GetDocs({documentId:[...allIds].map(id=>BigInt(id))}));
      const list=Array.isArray(docs)?docs:(docs?.documents||[]);
      const byId=new Map(list.map(doc=>[customEmojiId(doc),doc]));
      for(const [key,{glyph,ids}] of candidates){
        const expected=normalizeEmoji(glyph);
        for(const id of ids){
          const doc=byId.get(id);
          const alt=normalizeEmoji(customEmojiAttr(doc)?.alt||'');
          if(doc&&alt===expected){
            current['NEXAI_EMOJI_'+key]=id;
            changed=true;
            break;
          }
        }
      }
    }catch(error){
      console.warn('[NexAccount premium-emoji] documents',String(error?.errorMessage||error?.message||error).slice(0,200));
    }
  }

  // Fallback for accounts where SearchCustomEmoji returns no useful matches:
  // scan Telegram's installed/featured custom-emoji sets and match by exact alt.
  let unresolved=missing.filter(key=>!/^\d{5,30}$/.test(String(current['NEXAI_EMOJI_'+key]||'')));
  if(unresolved.length){
    const sets=[];
    for(const methodName of ['GetEmojiStickers','GetFeaturedEmojiStickers']){
      const Request=Api.messages?.[methodName];
      if(typeof Request!=='function')continue;
      try{
        const result=await client.invoke(new Request({hash:BigInt(0)}));
        for(const set of result?.sets||[])sets.push(set);
      }catch(error){
        console.warn('[NexAccount premium-emoji]',methodName,String(error?.errorMessage||error?.message||error).slice(0,180));
      }
    }

    const uniqueSets=[];
    const seen=new Set();
    for(const set of sets){
      const id=String(set?.id??'');
      if(!id||seen.has(id))continue;
      seen.add(id);
      uniqueSets.push(set);
    }

    const GetStickerSet=Api.messages?.GetStickerSet;
    const InputStickerSetID=Api.InputStickerSetID;
    if(typeof GetStickerSet==='function'&&typeof InputStickerSetID==='function'){
      for(const set of uniqueSets.slice(0,24)){
        if(!unresolved.length)break;
        const id=set?.id;
        const accessHash=set?.accessHash??set?.access_hash;
        if(id==null||accessHash==null)continue;
        try{
          const result=await client.invoke(new GetStickerSet({
            stickerset:new InputStickerSetID({id,accessHash}),
            hash:0
          }));
          for(const doc of result?.documents||[]){
            const docId=customEmojiId(doc);
            const alt=normalizeEmoji(customEmojiAttr(doc)?.alt||'');
            if(!docId||!alt)continue;
            for(const key of [...unresolved]){
              if(alt===normalizeEmoji(PREMIUM_EMOJI_GLYPHS[key])){
                current['NEXAI_EMOJI_'+key]=docId;
                unresolved=unresolved.filter(x=>x!==key);
                changed=true;
              }
            }
          }
        }catch{}
      }
    }
  }

  if(!changed){
    console.warn('[NexAccount premium-emoji]',accountId,'no custom emoji match for',missing.join(','));
    return settings;
  }
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
