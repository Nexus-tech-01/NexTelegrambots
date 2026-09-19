import { Bot, InputFile } from 'grammy';
import { cfg, isOwnerId } from './config.mjs';
import { loadBotToken } from './secrets.mjs';
import { commandMap } from './commands.mjs';
import { listAccounts, settingsFor, patchSettings } from './store.mjs';
import { menuModel, stylesModel } from './menu.mjs';
import { creatorCaptionModel, creatorImagePath } from './creator.mjs';
import { observeUser, recordEvent } from './analytics.mjs';
import { ownerPanelText, countriesText, languagesText, userText, botStatsText, activityText, growthText, commandStatsText } from './owner.mjs';
import { attachConnectedClient } from './runtime.mjs';
import { toSmallCaps } from './styles.mjs';

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

function accountForId(accounts,id){
  return accounts.find(a=>String(a.telegramUserId)===String(id))||null;
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

function inlineResult(model,accountId,id='menu'){
  const reply_markup=stampMarkup(model.reply_markup,accountId);
  if(model.photoUrl){
    return {
      type:'photo',id,
      photo_url:model.photoUrl,
      thumbnail_url:model.photoUrl,
      caption:model.text.slice(0,1024),
      caption_entities:model.entities.filter(e=>e.offset+e.length<=1024),
      reply_markup
    };
  }
  return {
    type:'article',id,title:'NexAI',description:'NexAccount menu',
    input_message_content:{
      message_text:model.text.slice(0,4096),
      entities:model.entities.filter(e=>e.offset+e.length<=4096),
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

async function editInline(ctx,model,accountId){
  const inlineId=ctx.callbackQuery.inline_message_id;
  if(!inlineId)return;
  const reply_markup=stampMarkup(model.reply_markup,accountId);
  try{
    await ctx.api.editMessageCaption({
      inline_message_id:inlineId,
      caption:model.text.slice(0,1024),
      caption_entities:model.entities.filter(e=>e.offset+e.length<=1024),
      reply_markup
    });
  }catch{
    await ctx.api.editMessageText({
      inline_message_id:inlineId,
      text:model.text.slice(0,4096),
      entities:model.entities.filter(e=>e.offset+e.length<=4096),
      link_preview_options:{is_disabled:true},
      reply_markup
    }).catch(()=>{});
  }
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
  const accounts=await listAccounts();
  const paired=!!accountForId(accounts,ctx.from.id);
  const text=lang==='en'
    ? [
      '♰ ɴᴇxᴀɪ','',
      paired?'🔗 ᴀᴄᴄᴏᴜɴᴛ • ᴄᴏɴɴᴇᴄᴛᴇᴅ':'🔗 ᴄᴏɴɴᴇᴄᴛ ʏᴏᴜʀ ᴛᴇʟᴇɢʀᴀᴍ ᴀᴄᴄᴏᴜɴᴛ',
      paired?'ᴜѕᴇ .ᴍᴇɴᴜ ғʀᴏᴍ ʏᴏᴜʀ ᴘᴇʀѕᴏɴᴀʟ ᴀᴄᴄᴏᴜɴᴛ.':'/pair',
      '',
      '/creator',
      '/language'
    ].join('\n')
    : [
      '♰ ɴᴇxᴀɪ','',
      paired?'🔗 ᴄᴏᴍᴘᴛᴇ • ᴄᴏɴɴᴇᴄᴛé':'🔗 ʀᴇʟɪᴇ ᴛᴏɴ ᴄᴏᴍᴘᴛᴇ ᴛᴇʟᴇɢʀᴀᴍ',
      paired?'ᴜᴛɪʟɪѕᴇ .ᴍᴇɴᴜ ᴅᴇᴘᴜɪѕ ᴛᴏɴ ᴄᴏᴍᴘᴛᴇ ᴘᴇʀѕᴏɴɴᴇʟ.':'/pair',
      '',
      '/creator',
      '/language'
    ].join('\n');
  return ctx.reply(text,{entities:quotedEntities(text,['/pair','/creator','/language'])});
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
    const accounts=await listAccounts();
    const account=accountForId(accounts,ctx.inlineQuery.from.id);
    if(!account){
      await ctx.answerInlineQuery([], {cache_time:0,is_personal:true});
      return;
    }
    const model=await modelFor(account,ctx.inlineQuery.query);
    await ctx.answerInlineQuery([inlineResult(model,account.telegramUserId,'nex-'+Date.now())],{
      cache_time:0,is_personal:true
    });
  });

  bot.on('callback_query:data',async ctx=>{
    const raw=String(ctx.callbackQuery.data||'');
    const cut=raw.lastIndexOf('|');
    if(cut<0){await ctx.answerCallbackQuery();return}
    const action=raw.slice(0,cut),accountId=raw.slice(cut+1);
    if(String(ctx.from.id)!==String(accountId)){
      await ctx.answerCallbackQuery({text:'Ce menu appartient au compte connecté.',show_alert:false});
      return;
    }
    const accounts=await listAccounts();
    const account=accountForId(accounts,accountId);
    if(!account){await ctx.answerCallbackQuery({text:'Compte déconnecté.'});return}
    let model;
    if(action==='menu:home')model=await modelFor(account,'menu');
    else if(action.startsWith('cat:'))model=await modelFor(account,action);
    else {await ctx.answerCallbackQuery();return}
    await editInline(ctx,model,accountId);
    await recordEvent(ctx.from,'callback',{source:'nexai',command:action,chatType:'inline'}).catch(()=>{});
    await ctx.answerCallbackQuery();
  });

  bot.catch(e=>console.error('[NexAI Bot]',e.error||e));
  bot.start({drop_pending_updates:false}).catch(e=>console.error('[NexAI start]',e));
  const me=await bot.api.getMe();
  cfg.botUsername=cfg.botUsername||me.username;
  console.log('[NexAccount] inline bot @'+me.username+' online');
  return bot;
}

export async function stopInlineBot(){
  try{await bot?.stop()}catch{}
}
