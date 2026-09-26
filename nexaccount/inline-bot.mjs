import { Bot, InputFile } from 'grammy';
import { cfg, isOwnerId } from './config.mjs';
import { loadBotToken } from './secrets.mjs';
import { commandMap } from './commands.mjs';
import { accountRecord, settingsFor, patchSettings } from './store.mjs';
import { menuModel, stylesModel } from './menu.mjs';
import { creatorCaptionModel, creatorImagePath } from './creator.mjs';
import { observeUser, recordEvent } from './analytics.mjs';
import { ownerPanelText, countriesText, languagesText, userText, botStatsText, activityText, growthText, commandStatsText } from './owner.mjs';
import { listStyles, toSmallCaps } from './styles.mjs';

const commands=commandMap();
const utf16len=s=>Buffer.from(String(s),'utf16le').length/2;
const webPairUsers=new Map();
let bot;

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

function connectMarkup(lang){
  return {
    inline_keyboard:[[
      {
        text:lang==='en'?'Open secure connection':'Ouvrir la connexion sécurisée',
        url:cfg.connectUrl
      }
    ]]
  };
}

async function sendPairLink(ctx,lang){
  rememberWebPair(ctx.from.id);
  const t=lang==='en'
    ? 'Telegram invalidates login codes when they are sent inside another Telegram chat.\n\nOpen the secure NexAI page below, enter your phone number there, then enter the Telegram code on that page — never in this bot chat.'
    : 'Telegram invalide les codes de connexion lorsqu’ils sont envoyés dans un autre chat Telegram.\n\nOuvre la page sécurisée NexAI ci-dessous, saisis ton numéro là-bas, puis entre le code Telegram sur cette page — jamais dans le chat du bot.';
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

function inlineResult(model,accountId,id='menu',forceArticle=false,portable=false){
  const stamped=stampMarkup(model.reply_markup,accountId);
  const reply_markup=portable?portableMarkup(stamped):stamped;
  const captionEntities=portable?[]:model.entities.filter(e=>e.offset+e.length<=1024);
  const textEntities=portable?[]:model.entities.filter(e=>e.offset+e.length<=4096);
  if(model.photoUrl&&!forceArticle){
    return {
      type:'photo',id,
      photo_url:model.photoUrl,
      thumbnail_url:model.photoUrl,
      caption:model.text.slice(0,1024),
      caption_entities:captionEntities,
      reply_markup
    };
  }
  return {
    type:'article',id,title:'NexAI',description:'NexAccount menu',
    input_message_content:{
      message_text:model.text.slice(0,4096),
      entities:textEntities,
      link_preview_options:{is_disabled:true}
    },
    reply_markup
  };
}

async function modelFor(account,query){
  const settings=await settingsFor(account.telegramUserId);
  const q=String(query||'').trim().toLowerCase();
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

  if(model.photoUrl){
    try{
      return await ctx.replyWithPhoto(model.photoUrl,{
        caption:model.text.slice(0,1024),
        caption_entities:model.entities.filter(e=>e.offset+e.length<=1024),
        reply_markup:rich
      });
    }catch(error){
      errors.push('photo:'+String(error?.description||error?.message||error).slice(0,350));
    }
  }

  try{
    return await ctx.reply(model.text.slice(0,4096),{
      entities:model.entities.filter(e=>e.offset+e.length<=4096),
      link_preview_options:{is_disabled:true},
      reply_markup:rich
    });
  }catch(error){
    errors.push('text-rich:'+String(error?.description||error?.message||error).slice(0,350));
  }

  try{
    return await ctx.reply(model.text.slice(0,4096),{
      link_preview_options:{is_disabled:true},
      reply_markup:plain
    });
  }catch(error){
    errors.push('text-portable:'+String(error?.description||error?.message||error).slice(0,350));
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

  // Context edit methods work for both inline_message_id callbacks and normal
  // bot messages. This keeps /menu and .menu on the same navigation engine.
  if(replaceMedia&&model.photoUrl){
    for(const [kind,reply_markup] of markups){
      try{
        await ctx.editMessageMedia({
          type:'photo',
          media:model.photoUrl,
          caption:model.text.slice(0,1024),
          caption_entities:kind==='rich'?model.entities.filter(e=>e.offset+e.length<=1024):[]
        },{reply_markup});
        return 'media-'+kind;
      }catch(error){
        errors.push('media-'+kind+':'+String(error?.description||error?.message||error).slice(0,350));
      }
    }
  }

  for(const [kind,reply_markup] of markups){
    try{
      await ctx.editMessageCaption({
        caption:model.text.slice(0,1024),
        caption_entities:kind==='rich'?model.entities.filter(e=>e.offset+e.length<=1024):[],
        reply_markup
      });
      return 'caption-'+kind;
    }catch(error){
      errors.push('caption-'+kind+':'+String(error?.description||error?.message||error).slice(0,350));
    }
  }

  for(const [kind,reply_markup] of markups){
    try{
      await ctx.editMessageText(model.text.slice(0,4096),{
        entities:kind==='rich'?model.entities.filter(e=>e.offset+e.length<=4096):[],
        link_preview_options:{is_disabled:true},
        reply_markup
      });
      return 'text-'+kind;
    }catch(error){
      errors.push('text-'+kind+':'+String(error?.description||error?.message||error).slice(0,350));
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
  if(kind==='owner'||kind==='users')text=await ownerPanelText(lang);
  else if(kind==='botstats')text=await botStatsText(lang);
  else if(kind==='activity')text=await activityText(lang);
  else if(kind==='growth')text=await growthText(lang);
  else if(kind==='commandstats')text=await commandStatsText(lang);
  else if(kind==='countries')text=await countriesText(lang);
  else if(kind==='languages')text=await languagesText(lang);
  else if(kind==='user')text=await userText(args[0]||'',lang);
  if(!text)return;
  await recordEvent(ctx.from,'owner_command',{source:'nexai',command:kind,chatType:ctx.chat?.type||'private'}).catch(()=>{});
  return ctx.reply(text,{entities:ownerEntities(text)});
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
  await bot.api.setChatMenuButton({menu_button:{type:'commands'}}).catch(()=>{});
  console.log('[NexAI] Telegram command menu synced · '+rows.length+' commands');
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
    const resultId='nex-'+Date.now();
    const attempts=[
      ['photo-rich',inlineResult(model,account.telegramUserId,resultId,false,false)],
      ['article-rich',inlineResult(model,account.telegramUserId,resultId,true,false)],
      ['article-portable',inlineResult(model,account.telegramUserId,resultId,true,true)]
    ];
    const errors=[];
    for(const [kind,result] of attempts){
      if(kind==='photo-rich'&&!model.photoUrl)continue;
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
    if(String(ctx.from.id)!==String(accountId)){
      await ctx.answerCallbackQuery({text:'Ce menu appartient au compte connecté.',show_alert:false});
      return;
    }
    const account=await accountRecord(accountId);
    if(!account||account.enabled!==true){await ctx.answerCallbackQuery({text:'Compte déconnecté.'});return}
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
      await ctx.answerCallbackQuery({text:'Impossible de mettre à jour ce menu. Réessaie avec .menu',show_alert:false}).catch(()=>{});
    }
  });

  bot.catch(e=>console.error('[NexAI Bot]',e.error||e));
  await syncTelegramCommandMenu(bot).catch(e=>console.error('[NexAI commands]',String(e?.description||e?.message||e)));
  bot.start({drop_pending_updates:false}).catch(e=>console.error('[NexAI start]',e));
  const me=await bot.api.getMe();
  cfg.botUsername=cfg.botUsername||me.username;
  console.log('[NexAccount] inline bot @'+me.username+' online');
  return bot;
}

export async function stopInlineBot(){
  try{await bot?.stop()}catch{}
}


export const __test={stampMarkup,portableMarkup,inlineResult,telegramCommandMenu};
