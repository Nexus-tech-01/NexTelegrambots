import { Bot } from 'grammy';
import { cfg } from './config.mjs';
import { commandMap } from './commands.mjs';
import { listAccounts, settingsFor } from './store.mjs';
import { menuModel, stylesModel } from './menu.mjs';

const commands=commandMap();
let bot;

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
      type:'photo',
      id,
      photo_url:model.photoUrl,
      thumbnail_url:model.photoUrl,
      caption:model.text.slice(0,1024),
      caption_entities:model.entities.filter(e=>e.offset+e.length<=1024),
      reply_markup
    };
  }
  return {
    type:'article',
    id,
    title:'NexAI',
    description:'NexAccount menu',
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
  if(q.startsWith('cat:'))return menuModel({account,settings,commands,view:'category',category:q.slice(4).toUpperCase()});
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

export async function startInlineBot(){
  if(!cfg.botToken){
    console.warn('[NexAccount] NEXAI_BOT_TOKEN missing: inline menus disabled');
    return null;
  }
  bot=new Bot(cfg.botToken);

  bot.on('inline_query',async ctx=>{
    const accounts=await listAccounts();
    const account=accountForId(accounts,ctx.inlineQuery.from.id);
    if(!account){
      await ctx.answerInlineQuery([], {cache_time:0,is_personal:true});
      return;
    }
    const model=await modelFor(account,ctx.inlineQuery.query);
    await ctx.answerInlineQuery([inlineResult(model,account.telegramUserId,'nex-'+Date.now())],{
      cache_time:0,
      is_personal:true
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
