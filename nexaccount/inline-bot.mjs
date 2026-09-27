import { Bot, InputFile } from 'grammy';
import { cfg, isOwnerId } from './config.mjs';
import { loadBotToken } from './secrets.mjs';
import { commandMap } from './commands.mjs';
import { accountRecord, settingsFor, patchSettings, saveSharedBotIdentity } from './store.mjs';
import { menuModel, stylesModel } from './menu.mjs';
import { creatorCaptionModel, creatorImagePath } from './creator.mjs';
import { getInlineResponse } from './inline-response-store.mjs';
import { observeUser, recordEvent } from './analytics.mjs';
import { ownerPanelText, usersText, countriesText, languagesText, userText, botStatsText, activityText, growthText, commandStatsText } from './owner.mjs';
import { listStyles, toSmallCaps } from './styles.mjs';
import { animatedCustomEmojiEntitySpecs, animatedCustomEmojiEntitySpecsFromLibrary, ensureEmojiLibraryPalette, sanitizeAnimatedEmojiText } from './response-ui.mjs';

const commands=commandMap();
const utf16len=s=>Buffer.from(String(s),'utf16le').length/2;
const INLINE_CUSTOM_EMOJI_GLYPHS={
  WAIT:'⏳',CHECK:'✅',ERROR:'❌',
  GENERAL:'🏠',ACCOUNT:'👤',AI:'🧠',DOWNLOAD:'📥',GROUP:'👥',SHIELD:'🔒',
  TOOLS:'🛠️',MEDIA:'🎞️',STICKER:'🎴',GAMES:'🎮',SEARCH:'🔎',ANIME:'🌸',
  PREMIUM:'👑',OWNER:'🔮',NEXTECH:'⚡',NEWS:'📰',DARK:'🕯️',BACK:'↩️',
  NEXT:'➡️',STYLE:'🎨'
};

function inlineCustomEmojiEntities(text,settings={}){
  return animatedCustomEmojiEntitySpecs(text,settings?.customEmojiIds||{});
}

const webPairUsers=new Map();
const photoFileIdCache=new Map();
const photoCachePending=new Map();
let bot;

async function cachePhotoFileId(photoUrl,chatId){
  const key=String(photoUrl||'').trim();
  if(!key||!chatId)return '';
  const cached=photoFileIdCache.get(key);
  if(cached)return cached;
  if(photoCachePending.has(key))return photoCachePending.get(key);

  const pending=(async()=>{
    let sent=null;
    try{
      sent=await bot.api.sendPhoto(chatId,key,{disable_notification:true});
      const photos=Array.isArray(sent?.photo)?sent.photo:[];
      const fileId=String(photos.at(-1)?.file_id||'');
      if(fileId){
        if(photoFileIdCache.size>=256){
          const first=photoFileIdCache.keys().next().value;
          if(first)photoFileIdCache.delete(first);
        }
        photoFileIdCache.set(key,fileId);
      }
      return fileId;
    }catch(error){
      console.warn('[NexAI artwork cache]',String(error?.description||error?.message||error).slice(0,350));
      return '';
    }finally{
      if(sent?.message_id)await bot.api.deleteMessage(chatId,sent.message_id).catch(()=>{});
      photoCachePending.delete(key);
    }
  })();
  photoCachePending.set(key,pending);
  return pending;
}

function rememberWebPair(userId){
  webPairUsers.set(String(userId),Date.now()+10*60*1000);
}

function webPairActive(userId){
  const key=String(userId);
  const until=Number(webPairUsers.get(key)||0);
  if(until>Date.now())return true;
  webPairUsers.delete(key);
  return false;
}

function callbackAccessAllowed(clickerId,accountId,accessMode='private'){
  return String(accessMode)==='public'||String(clickerId)===String(accountId);
}

function connectMarkup(lang){
  return {
    inline_keyboard:[[
      {
        text:lang==='en'?'Open Mini App':'Ouvrir la Mini App',
        web_app:{url:'https://nex-telegrambots.vercel.app/'}
      }
    ]]
  };
}

async function sendPairLink(ctx,lang){
  rememberWebPair(ctx.from.id);
  const t=lang==='en'
    ? 'Connect your Telegram account without leaving Telegram.\n\n1. Tap “Open Mini App”.\n2. Enter your Telegram phone number.\n3. Enter the login code only inside the Mini App.\n4. If Telegram asks for 2FA, enter the password only inside the Mini App.\n\nNever send a login code or 2FA password in this bot chat.'
    : 'Connecte ton compte Telegram sans quitter Telegram.\n\n1. Appuie sur « Ouvrir la Mini App ».\n2. Entre ton numéro Telegram.\n3. Entre le code de connexion uniquement dans la Mini App.\n4. Si Telegram demande la 2FA, entre le mot de passe uniquement dans la Mini App.\n\nN’envoie jamais un code de connexion ou un mot de passe 2FA dans ce chat.';
  return ctx.reply(t,{
    entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}],
    reply_markup:connectMarkup(lang),
    link_preview_options:{is_disabled:true}
  });
}

function stampMarkup(markup,accountId){
  const copy=structuredClone(markup||{inline_keyboard:[]});
  for(const row of copy.inline_keyboard||[]){
    for(const b of row){
      if(b.callback_data)b.callback_data=b.callback_data+'|'+String(accountId);
    }
  }
  return copy;
}

function portableMarkup(markup){
  const copy=structuredClone(markup||{inline_keyboard:[]});
  for(const row of copy.inline_keyboard||[]){
    for(const button of row){
      // Button colors and custom emoji are optional presentation features.
      // If Telegram rejects either capability, callbacks must still stay alive.
      delete button.style;
      delete button.icon_custom_emoji_id;
    }
  }
  return copy;
}

function portableEntities(entities,maxLength){
  const safe=new Set(['bot_command','blockquote','expandable_blockquote','text_link']);
  return (entities||[]).filter(e=>safe.has(e.type)&&e.offset+e.length<=maxLength);
}

function noEmojiPortableModel(model,maxLength=4096){
  const source=String(model?.text||'').slice(0,maxLength);
  const text=sanitizeAnimatedEmojiText(source,{});
  const allowed=new Set(['bot_command','blockquote','expandable_blockquote','text_link']);
  const entities=(model?.entities||[])
    .filter(e=>allowed.has(e.type)&&e.offset>=0&&e.length>0&&e.offset+e.length<=source.length)
    .map(e=>{
      const before=source.slice(0,e.offset);
      const inside=source.slice(e.offset,e.offset+e.length);
      return {
        ...e,
        offset:utf16len(sanitizeAnimatedEmojiText(before,{})),
        length:utf16len(sanitizeAnimatedEmojiText(inside,{}))
      };
    })
    .filter(e=>e.length>0);
  return {...model,text,entities};
}

function textInputContent(model,entities,disableArtwork=false){
  return {
    message_text:model.text.slice(0,4096),
    entities,
    link_preview_options:!disableArtwork&&model.photoUrl
      ?{url:model.photoUrl,prefer_large_media:true,show_above_text:true}
      :{is_disabled:true}
  };
}

function inlineCachedPhotoResult(model,accountId,id,fileId,portable=false){
  const stamped=stampMarkup(model.reply_markup,accountId);
  const reply_markup=portable?portableMarkup(stamped):stamped;
  const safeModel=portable?noEmojiPortableModel(model,4096):model;
  const textEntities=portable?safeModel.entities:model.entities.filter(e=>e.offset+e.length<=4096);
  return {
    type:'photo',
    id,
    photo_file_id:fileId,
    input_message_content:textInputContent(safeModel,textEntities),
    reply_markup
  };
}

function inlineResult(model,accountId,id='menu',forceArticle=false,portable=false,disableArtwork=false){
  const stamped=stampMarkup(model.reply_markup,accountId);
  const reply_markup=portable?portableMarkup(stamped):stamped;
  const safeModel=portable?noEmojiPortableModel(model,4096):model;
  const textEntities=portable?safeModel.entities:model.entities.filter(e=>e.offset+e.length<=4096);
  const input_message_content=textInputContent(safeModel,textEntities,disableArtwork);

  // A photo result keeps a visual thumbnail in the inline picker, but
  // input_message_content makes Telegram send an editable TEXT message with
  // the artwork as a large link preview. This avoids the 1024-char caption
  // limit and keeps Home -> Category navigation in one stable message.
  if(model.photoUrl&&!forceArticle){
    return {
      type:'photo',id,
      photo_url:model.photoUrl,
      thumbnail_url:model.photoUrl,
      input_message_content,
      reply_markup
    };
  }
  return {
    type:'article',id,title:'NexAI',description:'NexAccount menu',
    input_message_content,
    reply_markup
  };
}

function inlineReplyModel(value,settings={}){
  const raw=sanitizeAnimatedEmojiText(String(value??'').trim(),settings?.customEmojiIds||{});
  const label='By Nextech';
  const maxBase=Math.max(0,4096-label.length-2);
  const base=raw.slice(0,maxBase);
  const text=(base?base+'\n\n':'')+label;
  const entities=[];

  for(const m of text.matchAll(/\/[a-z][a-z0-9_]{0,63}/gi)){
    entities.push({
      type:'bot_command',
      offset:utf16len(text.slice(0,m.index)),
      length:utf16len(m[0])
    });
  }
  entities.push(...inlineCustomEmojiEntities(text,settings));

  const linkStart=text.lastIndexOf(label);
  if(cfg.nextechUrl&&linkStart>=0){
    entities.push({
      type:'text_link',
      offset:utf16len(text.slice(0,linkStart)),
      length:utf16len(label),
      url:cfg.nextechUrl
    });
  }

  const customId=String(settings?.customEmojiIds?.NEXAI_EMOJI_NEXTECH||'').trim();
  const hasCustom=/^\d{5,30}$/.test(customId);
  const button={text:(hasCustom?'':'⚡ ')+'ɴᴇxᴛᴇᴄʜ',url:cfg.nextechUrl,style:'success'};
  if(hasCustom)button.icon_custom_emoji_id=customId;

  return {
    text,
    entities,
    reply_markup:{inline_keyboard:cfg.nextechUrl?[[button]]:[]},
    photoUrl:''
  };
}

async function inlineReplyModelFromLibrary(value,settings={}){
  const model=inlineReplyModel(value,settings);
  const withoutCustom=(model.entities||[]).filter(e=>e.type!=='custom_emoji');
  const libraryEntities=await animatedCustomEmojiEntitySpecsFromLibrary(
    model.text,
    settings?.customEmojiIds||{},
    {sourceUsername:cfg.creatorUsername||'tresor20001'}
  );
  return {...model,entities:[...withoutCustom,...libraryEntities]};
}

async function modelFor(account,query){
  const settings=await ensureEmojiLibraryPalette(account.telegramUserId,{
    sourceUsername:cfg.creatorUsername||'tresor20001'
  }).catch(()=>settingsFor(account.telegramUserId));
  const rawQuery=String(query||'').trim();
  const q=rawQuery.toLowerCase();
  if(q.startsWith('reply:')){
    const token=rawQuery.slice('reply:'.length).trim();
    const row=await getInlineResponse(token,account.telegramUserId);
    if(!row){
      console.warn('[NexAI inline reply] missing_or_expired',String(account.telegramUserId),token.slice(0,8));
      return null;
    }
    return inlineReplyModelFromLibrary(row.text,settings);
  }
  if(q==='styles'||q==='style')return stylesModel({account,settings});
  if(q.startsWith('cat:')){
    const [,catRaw,pageRaw='0']=q.split(':');
    return menuModel({account,settings,commands,view:'category',category:String(catRaw||'').toUpperCase(),page:Number(pageRaw)||0});
  }
  return menuModel({account,settings,commands,view:'home'});
}

async function sendModelMessage(ctx,model,accountId){
  const rich=stampMarkup(model.reply_markup,accountId);
  const plain=portableMarkup(rich);
  const errors=[];
  const preview=model.photoUrl
    ?{url:model.photoUrl,prefer_large_media:true,show_above_text:true}
    :{is_disabled:true};
  const noEmoji=noEmojiPortableModel(model,4096);
  const attempts=[
    ['text-rich',model.text,model.entities.filter(e=>e.offset+e.length<=4096),preview,rich],
    ['text-portable-buttons',model.text,model.entities.filter(e=>e.offset+e.length<=4096),preview,plain],
    ['text-no-artwork',noEmoji.text,noEmoji.entities,{is_disabled:true},plain]
  ];

  for(const [kind,messageText,entities,link_preview_options,reply_markup] of attempts){
    try{
      return await ctx.reply(messageText.slice(0,4096),{
        entities,
        link_preview_options,
        reply_markup
      });
    }catch(error){
      errors.push(kind+':'+String(error?.description||error?.message||error).slice(0,350));
    }
  }
  throw new Error('menu_send_failed '+errors.join(' | '));
}

async function sendDirectMenu(ctx,account,query='menu'){
  const model=await modelFor(account,query);
  return sendModelMessage(ctx,model,account.telegramUserId);
}

async function editInline(ctx,model,accountId,{replaceMedia=false}={}){
  const target=ctx.callbackQuery.inline_message_id||ctx.callbackQuery.message;
  if(!target)throw new Error('callback_message_target_missing');
  const rich=stampMarkup(model.reply_markup,accountId);
  const markups=[['rich',rich],['portable',portableMarkup(rich)]];
  const errors=[];
  const preview=model.photoUrl
    ?{url:model.photoUrl,prefer_large_media:true,show_above_text:true}
    :{is_disabled:true};

  // New menus are always editable text messages. Artwork is optional:
  // a dead/unsupported preview must never prevent categories or styles from loading.
  const noEmoji=noEmojiPortableModel(model,4096);
  const textAttempts=[
    ['rich',model.text,rich,model.entities.filter(e=>e.offset+e.length<=4096),preview],
    ['portable-buttons',model.text,portableMarkup(rich),model.entities.filter(e=>e.offset+e.length<=4096),preview],
    ['no-artwork',noEmoji.text,portableMarkup(rich),noEmoji.entities,{is_disabled:true}]
  ];
  for(const [kind,messageText,reply_markup,entities,link_preview_options] of textAttempts){
    try{
      await ctx.editMessageText(messageText.slice(0,4096),{
        entities,
        link_preview_options,
        reply_markup
      });
      return 'text-'+kind;
    }catch(error){
      errors.push('text-'+kind+':'+String(error?.description||error?.message||error).slice(0,350));
    }
  }

  // Compatibility only for old photo-menu messages created before this
  // refactor. Never truncate a long category merely to fit a media caption.
  if(model.text.length<=1024){
    for(const [kind,reply_markup] of markups){
      try{
        await ctx.editMessageCaption({
          caption:kind==='rich'?model.text:noEmojiPortableModel(model,1024).text,
          caption_entities:kind==='rich'?model.entities.filter(e=>e.offset+e.length<=1024):noEmojiPortableModel(model,1024).entities,
          reply_markup
        });
        return 'legacy-caption-'+kind;
      }catch(error){
        errors.push('legacy-caption-'+kind+':'+String(error?.description||error?.message||error).slice(0,350));
      }
    }
  }

  throw new Error('menu_edit_failed '+errors.join(' | '));
}

async function preferredLanguage(userId,telegramLanguage=''){
  const s=await settingsFor(userId).catch(()=>null);
  const v=String(s?.language||telegramLanguage||'fr').toLowerCase();
  return v.startsWith('en')?'en':'fr';
}

function quotedEntities(text,commandsList=[]){
  const entities=[{type:'expandable_blockquote',offset:0,length:utf16len(text)}];
  for(const c of commandsList){
    let from=0;
    while(true){
      const i=text.indexOf(c,from);
      if(i<0)break;
      entities.push({type:'bot_command',offset:utf16len(text.slice(0,i)),length:utf16len(c)});
      from=i+c.length;
    }
  }
  return entities;
}

function ownerEntities(text){
  const entities=[{type:'expandable_blockquote',offset:0,length:utf16len(text)}];
  const re=/\/[a-z][a-z0-9_]*/gi;
  for(const m of text.matchAll(re)){
    entities.push({type:'bot_command',offset:utf16len(text.slice(0,m.index)),length:utf16len(m[0])});
  }
  return entities;
}

async function sendBareLanguage(ctx,arg=''){
  const value=String(arg||'').trim().toLowerCase();
  if(value==='fr'||value==='en'){
    await patchSettings(ctx.from.id,{language:value});
    const t=value==='fr'?'🇫🇷 ʟᴀɴɢᴜᴇ • ғʀᴀɴçᴀɪѕ':'🇬🇧 ʟᴀɴɢᴜᴀɢᴇ • ᴇɴɢʟɪѕʜ';
    return ctx.reply(t,{entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}]});
  }
  const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
  const t=lang==='en'?'ᴜѕᴇ language fr ᴏʀ language en.':'ᴜᴛɪʟɪѕᴇ language fr ᴏᴜ language en.';
  return ctx.reply(t,{entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}]});
}

async function handleBareDirectCommand(ctx,text){
  const value=String(text||'').trim();
  if(!value)return false;
  const [rawName,...args]=value.split(/\s+/);
  const name=String(rawName||'').toLowerCase();

  if(name==='start'){await sendStart(ctx);return true}
  if(name==='menu'||name==='help'){
    const account=await accountRecord(ctx.from.id);
    if(!account||account.enabled!==true){
      const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
      await sendPairLink(ctx,lang);
      return true;
    }
    await recordEvent(ctx.from,'command',{source:'nexai',command:name,chatType:ctx.chat?.type||'private'}).catch(()=>{});
    await sendDirectMenu(ctx,account,'menu');
    return true;
  }
  if(name==='style'||name==='styles'){
    const account=await accountRecord(ctx.from.id);
    if(!account||account.enabled!==true){
      const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
      await sendPairLink(ctx,lang);
      return true;
    }
    await sendDirectMenu(ctx,account,'styles');
    return true;
  }
  if(['creator','about','founder','ceo'].includes(name)){await sendCreator(ctx);return true}
  if(name==='language'){await sendBareLanguage(ctx,args[0]||'');return true}
  if(name==='pair'){
    if(ctx.chat?.type==='private'){
      const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
      await sendPairLink(ctx,lang);
    }
    return true;
  }
  if(name==='cancel'){
    webPairUsers.delete(String(ctx.from.id));
    const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
    const t=lang==='en'?'✦ ᴄᴏɴɴᴇᴄᴛɪᴏɴ ᴘʀᴏᴍᴘᴛ ᴄʟᴏѕᴇᴅ.':'✦ ᴘᴀʀᴄᴏᴜʀѕ ᴅᴇ ᴄᴏɴɴᴇxɪᴏɴ ғᴇʀᴍé.';
    await ctx.reply(t,{entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}]});
    return true;
  }
  if(name==='ping'){
    await recordEvent(ctx.from,'command',{source:'nexai',command:'ping',chatType:ctx.chat?.type||'private'}).catch(()=>{});
    await ctx.reply('Pong');
    return true;
  }
  if(name==='alive'){
    await recordEvent(ctx.from,'command',{source:'nexai',command:'alive',chatType:ctx.chat?.type||'private'}).catch(()=>{});
    await ctx.reply('NexAI · online');
    return true;
  }
  if(['owner','users','botstats','activity','growth','commandstats','countries','languages','user'].includes(name)){
    await sendOwner(ctx,name,args);
    return true;
  }
  return false;
}

async function sendStart(ctx){
  const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
  const account=await accountRecord(ctx.from.id);
  if(account?.enabled===true){
    await recordEvent(ctx.from,'command',{source:'nexai',command:'start',chatType:ctx.chat?.type||'private'}).catch(()=>{});
    return sendDirectMenu(ctx,account,'menu');
  }
  const text=lang==='en'
    ? ['♰ ɴᴇxᴀɪ','','🔗 ᴄᴏɴɴᴇᴄᴛ ʏᴏᴜʀ ᴛᴇʟᴇɢʀᴀᴍ ᴀᴄᴄᴏᴜɴᴛ','/pair','','/creator','/language'].join('\n')
    : ['♰ ɴᴇxᴀɪ','','🔗 ʀᴇʟɪᴇ ᴛᴏɴ ᴄᴏᴍᴘᴛᴇ ᴛᴇʟᴇɢʀᴀᴍ','/pair','','/creator','/language'].join('\n');
  return ctx.reply(text,{
    entities:quotedEntities(text,['/pair','/creator','/language']),
    reply_markup:connectMarkup(lang),
    link_preview_options:{is_disabled:true}
  });
}

async function sendCreator(ctx){
  const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
  const model=creatorCaptionModel(lang);
  await recordEvent(ctx.from,'command',{source:'nexai',command:'creator',chatType:ctx.chat?.type||'private'}).catch(()=>{});
  try{
    return await ctx.replyWithPhoto(new InputFile(creatorImagePath()),{
      caption:model.text,
      caption_entities:model.entities
    });
  }catch(e){
    console.error('[NexAI creator photo]',String(e.message||e));
    return ctx.reply(model.text,{entities:model.entities});
  }
}

async function sendOwner(ctx,kind,args=[]){
  if(!isOwnerId(ctx.from?.id))return;
  const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
  let text='';
  if(kind==='owner')text=await ownerPanelText(lang);
  else if(kind==='users')text=await usersText(lang);
  else if(kind==='botstats')text=await botStatsText(lang);
  else if(kind==='activity')text=await activityText(lang);
  else if(kind==='growth')text=await growthText(lang);
  else if(kind==='commandstats')text=await commandStatsText(lang);
  else if(kind==='countries')text=await countriesText(lang);
  else if(kind==='languages')text=await languagesText(lang);
  else if(kind==='user')text=await userText(args[0]||'',lang);
  if(!text)return;
  const settings=await settingsFor(ctx.from.id).catch(()=>null);
  const safe=sanitizeAnimatedEmojiText(text,settings?.customEmojiIds||{});
  await recordEvent(ctx.from,'owner_command',{source:'nexai',command:kind,chatType:ctx.chat?.type||'private'}).catch(()=>{});
  return ctx.reply(safe,{entities:[
    ...ownerEntities(safe),
    ...animatedCustomEmojiEntitySpecs(safe,settings?.customEmojiIds||{})
  ]});
}

function telegramCommandMenu(){
  // Only commands with real Bot API handlers belong in Telegram's native slash
  // menu. NexAccount commands are executed by the connected user session with
  // its configured prefix (normally ".") and must never be advertised here.
  return [
    {command:'start',description:'Démarrer NexAI'},
    {command:'menu',description:'Ouvrir le menu principal'},
    {command:'help',description:'Afficher l’aide'},
    {command:'pair',description:'Connecter un compte Telegram'},
    {command:'language',description:'Changer la langue'},
    {command:'creator',description:'Afficher le créateur'}
  ];
}

async function syncTelegramCommandMenu(bot){
  const rows=telegramCommandMenu();
  await bot.api.setMyCommands(rows);
  await bot.api.setChatMenuButton({
    menu_button:{
      type:'web_app',
      text:'Open',
      web_app:{url:'https://nex-telegrambots.vercel.app/'}
    }
  });
  console.log('[NexAI] Telegram command menu synced · '+rows.length+' commands · Mini App menu button active');
}

export async function startInlineBot(){
  const token=await loadBotToken();
  if(!token){
    console.warn('[NexAccount] NexAI token missing: inline menus disabled');
    return null;
  }
  bot=new Bot(token);

  bot.use(async(ctx,next)=>{
    if(ctx.from)await observeUser(ctx.from,{source:'nexai'}).catch(()=>{});
    return next();
  });

  bot.command('start',ctx=>sendStart(ctx));
  bot.command('menu',async ctx=>{
    const account=await accountRecord(ctx.from.id);
    if(!account||account.enabled!==true){
      const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
      return sendPairLink(ctx,lang);
    }
    await recordEvent(ctx.from,'command',{source:'nexai',command:'menu',chatType:ctx.chat?.type||'private'}).catch(()=>{});
    return sendDirectMenu(ctx,account,'menu');
  });
  bot.command('help',async ctx=>{
    const account=await accountRecord(ctx.from.id);
    if(account?.enabled===true)return sendDirectMenu(ctx,account,'menu');
    return sendStart(ctx);
  });
  for(const name of ['creator','about','founder','ceo'])bot.command(name,ctx=>sendCreator(ctx));

  bot.command('language',async ctx=>{
    const arg=String(ctx.match||'').trim().toLowerCase();
    if(arg==='fr'||arg==='en'){
      await patchSettings(ctx.from.id,{language:arg});
      const t=arg==='fr'?'🇫🇷 ʟᴀɴɢᴜᴇ • ғʀᴀɴçᴀɪѕ':'🇬🇧 ʟᴀɴɢᴜᴀɢᴇ • ᴇɴɢʟɪѕʜ';
      return ctx.reply(t,{entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}]});
    }
    const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
    const t=lang==='en'?'ᴜѕᴇ /language fr ᴏʀ /language en.':'ᴜᴛɪʟɪѕᴇ /language fr ᴏᴜ /language en.';
    return ctx.reply(t,{entities:quotedEntities(t,['/language'])});
  });

  bot.command('pair',async ctx=>{
    if(ctx.chat?.type!=='private')return;
    const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
    return sendPairLink(ctx,lang);
  });

  bot.command('cancel',async ctx=>{
    webPairUsers.delete(String(ctx.from.id));
    const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
    const t=lang==='en'?'✦ ᴄᴏɴɴᴇᴄᴛɪᴏɴ ᴘʀᴏᴍᴘᴛ ᴄʟᴏѕᴇᴅ.':'✦ ᴘᴀʀᴄᴏᴜʀѕ ᴅᴇ ᴄᴏɴɴᴇxɪᴏɴ ғᴇʀᴍé.';
    return ctx.reply(t,{entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}]});
  });

  bot.command('owner',ctx=>sendOwner(ctx,'owner'));
  bot.command('users',ctx=>sendOwner(ctx,'users'));
  bot.command('botstats',ctx=>sendOwner(ctx,'botstats'));
  bot.command('activity',ctx=>sendOwner(ctx,'activity'));
  bot.command('growth',ctx=>sendOwner(ctx,'growth'));
  bot.command('commandstats',ctx=>sendOwner(ctx,'commandstats'));
  bot.command('countries',ctx=>sendOwner(ctx,'countries'));
  bot.command('languages',ctx=>sendOwner(ctx,'languages'));
  bot.command('user',ctx=>sendOwner(ctx,'user',ctx.match?String(ctx.match).trim().split(/\s+/):[]));

  bot.on('message:text',async ctx=>{
    if(ctx.chat?.type!=='private')return;
    const text=String(ctx.message.text||'').trim();
    if(text.startsWith('/'))return;

    // The presentation bot also accepts native commands without a prefix.
    // Only explicit known command names are consumed, so normal conversation
    // text remains untouched.
    if(await handleBareDirectCommand(ctx,text))return;

    // Telegram automatically invalidates account login codes sent as messages
    // to any Telegram chat. Protect users who still try the legacy DM flow.
    if(webPairActive(ctx.from.id)&&/^[0-9-]{5,12}$/.test(text)){
      await ctx.deleteMessage().catch(()=>{});
      const lang=await preferredLanguage(ctx.from.id,ctx.from.language_code);
      const t=lang==='en'
        ? 'That login code is now unusable because it was sent in a Telegram chat. Request a new code from the secure page and enter it only there.'
        : 'Ce code est maintenant inutilisable parce qu’il a été envoyé dans un chat Telegram. Demande un nouveau code depuis la page sécurisée et saisis-le uniquement là-bas.';
      return ctx.reply(t,{
        entities:[{type:'expandable_blockquote',offset:0,length:utf16len(t)}],
        reply_markup:connectMarkup(lang),
        link_preview_options:{is_disabled:true}
      });
    }
  });

  bot.on('inline_query',async ctx=>{
    await recordEvent(ctx.inlineQuery.from,'inline_query',{source:'nexai',chatType:'inline'}).catch(()=>{});
    const account=await accountRecord(ctx.inlineQuery.from.id);
    if(!account||account.enabled!==true){
      await ctx.answerInlineQuery([], {cache_time:0,is_personal:true});
      return;
    }
    const model=await modelFor(account,ctx.inlineQuery.query);
    if(!model){
      // Never inject an "expired response" message into the user's chat.
      // Returning no result makes the connected account fall back to a direct
      // branded Telegram message containing the real command response.
      await ctx.answerInlineQuery([],{cache_time:0,is_personal:true});
      return;
    }
    const resultId='nex-'+Date.now();
    const cachedPhotoId=model.photoUrl
      ?await cachePhotoFileId(model.photoUrl,account.telegramUserId)
      :'';
    const attempts=[
      ...(cachedPhotoId?[['cached-photo-rich',inlineCachedPhotoResult(model,account.telegramUserId,resultId,cachedPhotoId,false)]]:[]),
      ['photo-rich',inlineResult(model,account.telegramUserId,resultId,false,false)],
      ['article-rich',inlineResult(model,account.telegramUserId,resultId,true,false)],
      ['article-portable',inlineResult(model,account.telegramUserId,resultId,true,true)],
      ['article-no-artwork',inlineResult(model,account.telegramUserId,resultId,true,true,true)]
    ];
    const errors=[];
    for(const [kind,result] of attempts){
      if(kind==='photo-rich'&&!model.photoUrl)continue;
      if(kind==='cached-photo-rich'&&!cachedPhotoId)continue;
      try{
        await ctx.answerInlineQuery([result],{cache_time:0,is_personal:true});
        if(errors.length)console.warn('[NexAI inline] recovered with',kind,'after',errors.join(' | '));
        return;
      }catch(error){
        errors.push(kind+':'+String(error?.description||error?.message||error).slice(0,350));
      }
    }
    throw new Error('inline_answer_failed '+errors.join(' | '));
  });

  bot.on('callback_query:data',async ctx=>{
    const raw=String(ctx.callbackQuery.data||'');
    const cut=raw.lastIndexOf('|');
    console.log('[NexAI callback] received',raw.slice(0,120),'from='+String(ctx.from?.id||''),'inline='+String(!!ctx.callbackQuery.inline_message_id));
    if(cut<0){await ctx.answerCallbackQuery();return}
    const action=raw.slice(0,cut),accountId=raw.slice(cut+1);
    const account=await accountRecord(accountId);
    if(!account||account.enabled!==true){await ctx.answerCallbackQuery({text:'Compte déconnecté.'});return}
    const settings=await settingsFor(accountId);
    if(!callbackAccessAllowed(ctx.from.id,accountId,settings.accessMode)){
      await ctx.answerCallbackQuery({text:'Ce menu appartient au compte connecté.',show_alert:false});
      return;
    }
    let model;
    let callbackText='';
    let replaceMedia=false;
    if(action==='menu:home'){
      model=await modelFor(account,'menu');
      replaceMedia=true;
    }else if(action==='menu:styles'){
      model=await modelFor(account,'styles');
      replaceMedia=true;
    }else if(action.startsWith('style:set:')){
      const styleId=Number(action.slice('style:set:'.length));
      const styles=await listStyles();
      const style=styles.find(s=>Number(s.id)===styleId&&Number(s.id)>0);
      if(!style){
        await ctx.answerCallbackQuery({text:'Style invalide.',show_alert:false});
        return;
      }
      await patchSettings(accountId,{style:styleId});
      model=await modelFor(account,'styles');
      callbackText='Style '+styleId+' · '+String(style.name||'NexAI')+' activé';
      replaceMedia=true;
    }else if(action.startsWith('cat:')){
      model=await modelFor(account,action);
    }else{
      await ctx.answerCallbackQuery();
      return;
    }

    try{
      const mode=await editInline(ctx,model,accountId,{replaceMedia});
      console.log('[NexAI callback] edited',action,'mode='+mode);
      await recordEvent(ctx.from,'callback',{source:'nexai',command:action,chatType:'inline'}).catch(()=>{});
      if(callbackText)await ctx.answerCallbackQuery({text:callbackText});
      else await ctx.answerCallbackQuery();
    }catch(error){
      const reason=String(error?.description||error?.message||error).slice(0,700);
      console.error('[NexAI callback] failed',action,reason);
      await ctx.answerCallbackQuery({text:'Impossible de mettre à jour ce menu. Réessaie avec /Menu',show_alert:false}).catch(()=>{});
    }
  });

  bot.catch(e=>console.error('[NexAI Bot]',e.error||e));
  await syncTelegramCommandMenu(bot).catch(e=>console.error('[NexAI commands]',String(e?.description||e?.message||e)));
  bot.start({drop_pending_updates:false}).catch(e=>console.error('[NexAI start]',e));
  const me=await bot.api.getMe();
  cfg.botUsername=String(me.username||cfg.botUsername||'').replace(/^@/,'');
  await saveSharedBotIdentity({
    username:cfg.botUsername,
    telegramBotId:String(me.id||'')
  }).catch(error=>console.warn('[NexAI bot identity] persist_failed',String(error?.message||error).slice(0,180)));
  console.log('[NexAccount] inline bot @'+me.username+' online');
  return bot;
}

export async function stopInlineBot(){
  try{await bot?.stop()}catch{}
}


export const __test={stampMarkup,portableMarkup,inlineResult,inlineCachedPhotoResult,inlineReplyModel,telegramCommandMenu,callbackAccessAllowed};
