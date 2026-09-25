import { cfg, isOwnerId } from './config.mjs';
import { CATEGORY_ICONS, CATEGORY_LABELS, CATEGORY_ORDER, commandsByCategory, commandStats } from './commands.mjs';
import { getStyle, listStyles, renderDipperHeader, resolveInlinePhoto, resolveStyleImage, telegramizeDipperText, toSmallCaps } from './styles.mjs';

const utf16len=s=>Buffer.from(String(s),'utf16le').length/2;
const FALLBACK_EMOJI={
  GENERAL:'🏠',ACCOUNT:'👤',AI:'🧠',DOWNLOAD:'📥',GROUP:'👥',ADMIN:'🛡️',
  PROTECTION:'🔒',TOOLS:'🛠️',MEDIA:'🎞️',STICKERS:'🎴',FUN:'🎮',ANIME:'🌸',
  SEARCH:'🔎',PREMIUM:'👑',OWNER:'🔮'
};

export function expandableEntities(text,commandSpans=[]){
  // NexAccount commands use the user's configured prefix (normally ".") and
  // are not Bot API slash commands. Marking them as bot_command made Telegram
  // route clicks to @NexAi01_bot instead of the connected account. Keep the
  // themed expandable quote, but never advertise a false clickable slash route.
  return [{type:'expandable_blockquote',offset:0,length:utf16len(text)}];
}

function commandText(lines,style,prefix='.'){
  let text='',spans=[];
  const marker='98765432101234567890';
  for(const line of lines){
    const command=String(prefix||'.')+line.name;
    let before=style.id===1?'┃➻ ':'• ',after='\n';
    if(style.exactCatCmd){
      try{
        const rendered=telegramizeDipperText(style.exactCatCmd({name:marker}));
        const at=rendered.indexOf(marker);
        if(at>=0){
          before=rendered.slice(0,at);
          after=rendered.slice(at+marker.length);
          if(!after.endsWith('\n'))after+='\n';
        }
      }catch{}
    }
    text+=before;
    const start=text.length;
    text+=command;
    spans.push({start,text:command});
    if(line.suffix)text+=line.suffix;
    text+=after;
  }
  return {text,spans};
}

function localized(settings,fr,en){
  return String(settings?.language||'fr').toLowerCase().startsWith('en')?en:fr;
}

async function menuArtwork(settings,styleId){
  // Custom artwork is bound to the style that was active when the user chose it.
  // Changing styles therefore cannot leave an unrelated old image attached.
  const bound=Number(settings?.menuImageStyle||0)===Number(styleId)
    ?String(settings?.menuImageUrl||'').trim()
    :'';
  if(bound){
    const custom=await resolveInlinePhoto(bound);
    if(custom)return custom;
  }
  return resolveStyleImage(styleId,'');
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
    const themedLabel=(FALLBACK_EMOJI[category]||'')+' '+label;

    body=header.trimEnd()+'\n\n';
    if(style.exactCatOpen){
      try{body+=telegramizeDipperText(style.exactCatOpen(themedLabel))}catch{body+=themedLabel+'\n'}
    }else body+=themedLabel+'\n';
    body+=toSmallCaps(localized(settings,'Commandes','Commands'))+' : '+list.length+
      ' · '+toSmallCaps(localized(settings,'Page','Page'))+' '+(page+1)+'/'+pages+'\n';

    const visibleCommands=pageList.map(c=>({
      name:c.name,
      suffix:[
        c.privateOnly?'  · '+toSmallCaps(localized(settings,'Privé','Private')):'',
        c.groupOnly?(c.adminOnly?'  · '+toSmallCaps(localized(settings,'Groupe/Admin','Group/Admin')):'  · '+toSmallCaps(localized(settings,'Groupe','Group'))):'',
        c.premium&&!account.premium?'  · 👑 '+toSmallCaps('Premium'):''
      ].join('')
    }));
    const ct=commandText(visibleCommands,style,settings.prefix||'.');
    const shift=body.length;
    body+=ct.text;
    spans.push(...ct.spans.map(x=>({...x,start:x.start+shift})));

    if(style.exactCatClose){
      try{body+=telegramizeDipperText(style.exactCatClose())}catch{}
    }
    if(style.exactFooter){
      try{body+='\n'+telegramizeDipperText(style.exactFooter())}catch{}
    }
    body+='\n'+toSmallCaps('Powered by Nextech');
  }else{
    body=header.trimEnd();
    if(style.exactFooter){
      try{body+='\n\n'+telegramizeDipperText(style.exactFooter())}catch{}
    }else if(style.tagline){
      body+='\n\n'+toSmallCaps(style.tagline);
    }
    body+='\n'+toSmallCaps('Powered by Nextech');
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
    buttons.push([button('🎨 '+toSmallCaps(localized(settings,'Styles','Styles')),'menu:styles','primary','style')]);
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
    photoUrl:await menuArtwork(settings,style.id)
  };
}

export async function stylesModel({account,settings}){
  const styles=(await listStyles()).filter(s=>s.id>0);
  const prefix=String(settings.prefix||'.');
  let text='🔮 ɴᴇxᴀɪ • ᴅɪᴘᴘᴇʀ • ѕᴛʏʟᴇѕ\n\n',spans=[];
  for(const s of styles){
    const command=prefix+'style'+s.id;
    const start=text.length;
    text+=command;
    spans.push({start,text:command});
    text+=' • '+toSmallCaps(s.name)+(Number(settings.style)===s.id?' • '+toSmallCaps(localized(settings,'Actif','Active')):'')+'\n';
  }
  text+='\n'+toSmallCaps(localized(settings,'Choisis un style ci-dessous ou utilise '+prefix+'style <numéro>.','Choose a style below or use '+prefix+'style <number>.'))+
    '\n♛ ɴᴇxᴀɪ • ᴅɪᴘᴘᴇʀ × ɴᴇxᴛᴇᴄʜ ♛';

  const keyboard=[];
  for(let i=0;i<styles.length;i+=2){
    keyboard.push(styles.slice(i,i+2).map(s=>{
      const active=Number(settings.style)===s.id;
      return button((active?'✓ ':'')+String(s.id)+' · '+toSmallCaps(s.name),'style:set:'+s.id,active?'success':'primary','style');
    }));
  }
  keyboard.push([button('↩ '+toSmallCaps(localized(settings,'Menu','Menu')),'menu:home','primary','back')]);

  return {
    text,
    entities:expandableEntities(text,spans),
    reply_markup:{inline_keyboard:keyboard},
    photoUrl:await menuArtwork(settings,settings.style||1)
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
