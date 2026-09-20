import { cfg, isOwnerId } from './config.mjs';
import { CATEGORY_ICONS, CATEGORY_LABELS, CATEGORY_ORDER, commandsByCategory, commandStats } from './commands.mjs';
import { getStyle, listStyles, renderDipperHeader, resolveStyleImage, toSmallCaps } from './styles.mjs';

const utf16len=s=>Buffer.from(String(s),'utf16le').length/2;
const FALLBACK_EMOJI={
  GENERAL:'🏠',ACCOUNT:'👤',AI:'🧠',DOWNLOAD:'📥',GROUP:'👥',ADMIN:'🛡️',
  PROTECTION:'🔒',TOOLS:'🛠️',MEDIA:'🎞️',STICKERS:'🎴',FUN:'🎮',ANIME:'🌸',
  SEARCH:'🔎',PREMIUM:'👑',OWNER:'🔮'
};

export function expandableEntities(text,commandSpans=[]){
  const entities=[{type:'expandable_blockquote',offset:0,length:utf16len(text)}];
  for(const span of commandSpans){
    entities.push({type:'bot_command',offset:utf16len(text.slice(0,span.start)),length:utf16len(span.text)});
  }
  return entities;
}

function commandText(lines,styleId=1){
  let text='',spans=[];
  for(const line of lines){
    const command='/'+line.name;
    const prefix=styleId===1?'┃➻ ':'• ';
    text+=prefix;
    const start=text.length;
    text+=command;
    spans.push({start,text:command});
    if(line.suffix)text+=line.suffix;
    text+='\n';
  }
  return {text,spans};
}

function localized(settings,fr,en){
  return String(settings?.language||'fr').toLowerCase().startsWith('en')?en:fr;
}

export async function menuModel({account,settings,commands,view='home',category=null,page=0}){
  const groups=commandsByCategory(commands);
  const style=await getStyle(settings.style||1);
  const owner=isOwnerId(account.telegramUserId);
  const visible=c=>!c.hidden&&(!c.ownerOnly||owner);
  const header=await renderDipperHeader(style.id,{
    botName:String(settings.botDisplayName||'NexAi · Dipper').slice(0,64),
    ownerName:account.username?'@'+account.username:(account.firstName||localized(settings,'Utilisateur','User')),
    rank:owner?'owner':account.premium?'premium':'free',
    prefix:settings.prefix||'.',
    count:commandStats(commands).tokens
  });
  let body=header,spans=[];

  if(view==='category'&&category){
    const list=(groups[category]||[]).filter(visible);
    const perPage=16;
    const pages=Math.max(1,Math.ceil(list.length/perPage));
    page=Math.max(0,Math.min(pages-1,Number(page)||0));
    const pageList=list.slice(page*perPage,(page+1)*perPage);
    const label=toSmallCaps(CATEGORY_LABELS[category]||category);
    if(style.id===1){
      body=[
        '╭╼━• '+(FALLBACK_EMOJI[category]||'🔮')+' '+label+' •━━━━',
        '┃ 🔮 '+localized(settings,'ᴀʀᴄᴀɴᴇ','ᴀʀᴄᴀɴᴇ')+' : '+label,
        '┃ 📜 '+localized(settings,'ᴄᴏᴍᴍᴀɴᴅᴇѕ','ᴄᴏᴍᴍᴀɴᴅѕ')+' : '+list.length+' · '+localized(settings,'ᴘᴀɢᴇ','ᴘᴀɢᴇ')+' '+(page+1)+'/'+pages,
        '╰━━━━━━━━━━━━━━','','♰ '+localized(settings,'ᴄᴏᴍᴍᴀɴᴅᴇѕ','ᴄᴏᴍᴍᴀɴᴅѕ'),''
      ].join('\n');
    }else{
      body+='\n'+label+'\n\n';
    }
    const visibleCommands=pageList.map(c=>({
      name:c.name,
      suffix:[
        c.privateOnly?'  · '+toSmallCaps(localized(settings,'Privé','Private')):'',
        c.groupOnly?(c.adminOnly?'  · '+toSmallCaps(localized(settings,'Groupe/Admin','Group/Admin')):'  · '+toSmallCaps(localized(settings,'Groupe','Group'))):'',
        c.premium&&!account.premium?'  · 👑 '+toSmallCaps('Premium'):''
      ].join('')
    }));
    const ct=commandText(visibleCommands,style.id);
    const shift=body.length;
    body+=ct.text;
    spans.push(...ct.spans.map(x=>({...x,start:x.start+shift})));
    if(style.id===1){
      body+='\n'+localized(settings,'🌑 ѕéʟᴇᴄᴛɪᴏɴɴᴇ ᴜɴᴇ ᴄᴏᴍᴍᴀɴᴅᴇ.','🌑 ѕᴇʟᴇᴄᴛ ᴀ ᴄᴏᴍᴍᴀɴᴅ.')+
        '\n\n♛ ɴᴇxᴀɪ • ᴅɪᴘᴘᴇʀ × ɴᴇxᴛᴇᴄʜ ♛';
    }else if(style.exactFooter){
      try{body+='\n'+style.exactFooter()}catch{}
    }
  }else{
    if(style.id===1){
      body+='\n♰ '+localized(settings,'ᴄʜᴏɪѕɪѕ ᴛᴏɴ ᴀʀᴄᴀɴᴇ','ᴄʜᴏᴏѕᴇ ʏᴏᴜʀ ᴀʀᴄᴀɴᴇ')+
        '\n\n🌑 '+localized(settings,"ʟ'ᴏᴍʙʀᴇ ᴏʙѕᴇʀᴠᴇ.","ᴛʜᴇ ѕʜᴀᴅᴏᴡ ᴡᴀᴛᴄʜᴇѕ.")+
        '\n🔮 '+localized(settings,'ʟᴇ ѕᴀɴᴄᴛᴜᴀɪʀᴇ ᴇѕᴛ ᴏᴜᴠᴇʀᴛ.','ᴛʜᴇ ѕᴀɴᴄᴛᴜᴀʀʏ ɪѕ ᴏᴘᴇɴ.')+
        '\n\n♛ ɴᴇxᴀɪ • ᴅɪᴘᴘᴇʀ × ɴᴇxᴛᴇᴄʜ ♛';
    }else{
      if(style.tagline)body+='\n'+toSmallCaps(style.tagline)+'\n';
      if(style.exactFooter){try{body+='\n'+style.exactFooter()}catch{}}
      body+='\n'+toSmallCaps('Powered by Nextech');
    }
  }

  const buttons=[];
  if(view==='home'){
    const cats=CATEGORY_ORDER.filter(cat=>(groups[cat]||[]).some(visible));
    for(let i=0;i<cats.length;i+=2){
      buttons.push(cats.slice(i,i+2).map(cat=>{
        const id=emojiId(CATEGORY_ICONS[cat]);
        const label=toSmallCaps(CATEGORY_LABELS[cat]||cat);
        return button((id?'':(FALLBACK_EMOJI[cat]||'')+' ')+label,'cat:'+cat,'primary',CATEGORY_ICONS[cat]);
      }));
    }
    const links=[];
    if(cfg.nextechUrl)links.push(urlButton('ɴᴇxᴛᴇᴄʜ',cfg.nextechUrl,'success','nextech'));
    if(cfg.nexnewsUrl)links.push(urlButton('ɴᴇxɴᴇᴡѕ',cfg.nexnewsUrl,'success','news'));
    if(cfg.darkUniverseUrl)links.push(urlButton('ᴅᴀʀᴋ ᴜɴɪᴠᴇʀѕᴇ',cfg.darkUniverseUrl,'success','dark'));
    if(links.length)buttons.push(links);
  }else{
    if(view==='category'&&category){
      const list=(groups[category]||[]).filter(visible);
      const perPage=16,pages=Math.max(1,Math.ceil(list.length/perPage));
      const current=Math.max(0,Math.min(pages-1,Number(page)||0));
      const nav=[];
      if(current>0)nav.push(button('‹ '+toSmallCaps(localized(settings,'Précédent','Previous')),'cat:'+category+':'+(current-1),'primary','back'));
      if(current<pages-1)nav.push(button(toSmallCaps(localized(settings,'Suivant','Next'))+' ›','cat:'+category+':'+(current+1),'primary','next'));
      if(nav.length)buttons.push(nav);
    }
    buttons.push([button('↩ '+toSmallCaps(localized(settings,'Menu','Menu')),'menu:home','primary','back')]);
  }
  const text=body.trim();
  return {
    text,
    entities:expandableEntities(text,spans),
    reply_markup:{inline_keyboard:buttons},
    photoUrl:String(settings.menuImageUrl||'').trim()||await resolveStyleImage(style.id,cfg.defaultMenuImage)
  };
}

export async function stylesModel({account,settings}){
  const styles=(await listStyles()).filter(s=>s.id>0);
  let text='🔮 ɴᴇxᴀɪ • ᴅɪᴘᴘᴇʀ • ѕᴛʏʟᴇѕ\n\n',spans=[];
  for(const s of styles){
    const command='/style'+s.id;
    const start=text.length;
    text+=command;
    spans.push({start,text:command});
    text+=' • '+toSmallCaps(s.name)+(Number(settings.style)===s.id?' • '+toSmallCaps(localized(settings,'Actif','Active')):'')+'\n';
  }
  text+='\n'+toSmallCaps(localized(settings,'Utilise aussi .style <numéro>.','You can also use .style <number>.'))+
    '\n♛ ɴᴇxᴀɪ • ᴅɪᴘᴘᴇʀ × ɴᴇxᴛᴇᴄʜ ♛';
  return {
    text,
    entities:expandableEntities(text,spans),
    reply_markup:{inline_keyboard:[[button('↩ '+toSmallCaps('Menu'),'menu:home','primary','back')]]},
    photoUrl:await resolveStyleImage(settings.style||1,cfg.defaultMenuImage)
  };
}

function emojiId(logical){
  const key='NEXAI_EMOJI_'+String(logical||'').toUpperCase().replace(/[^A-Z0-9]+/g,'_');
  return String(process.env[key]||'').trim()||undefined;
}

function button(text,data,style='primary',icon){
  const b={text,callback_data:data,style};
  const id=emojiId(icon);
  if(id)b.icon_custom_emoji_id=id;
  return b;
}

function urlButton(text,url,style='success',icon){
  const b={text,url,style};
  const id=emojiId(icon);
  if(id)b.icon_custom_emoji_id=id;
  return b;
}
