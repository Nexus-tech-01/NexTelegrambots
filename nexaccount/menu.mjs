import { cfg, isOwnerId } from './config.mjs';
import { CATEGORY_ICONS, CATEGORY_LABELS, CATEGORY_ORDER, commandsByCategory, commandStats } from './commands.mjs';
import { getStyle, listStyles, resolveInlinePhoto, resolveStyleImage, toSmallCaps } from './styles.mjs';
import { renderThemeHeader, renderThemeCategory } from './theme-ui.mjs';

const utf16len=s=>Buffer.from(String(s),'utf16le').length/2;
const FALLBACK_EMOJI={
  GENERAL:'🏠',ACCOUNT:'👤',AI:'🧠',DOWNLOAD:'📥',GROUP:'👥',ADMIN:'🛡️',
  PROTECTION:'🔒',TOOLS:'🛠️',MEDIA:'🎞️',STICKERS:'🎴',FUN:'🎮',ANIME:'🌸',
  SEARCH:'🔎',PREMIUM:'👑',OWNER:'🔮'
};
const BUTTON_LABELS={PROTECTION:'PROTECT',PREMIUM:'PREMIUM'};

export function expandableEntities(text,commandSpans=[],quoteRange=null){
  const entities=[];
  if(quoteRange&&Number(quoteRange.length)>0){
    entities.push({
      type:'blockquote',
      offset:utf16len(text.slice(0,quoteRange.start)),
      length:utf16len(text.slice(quoteRange.start,quoteRange.start+quoteRange.length))
    });
  }
  for(const span of commandSpans){
    entities.push({
      type:'bot_command',
      offset:utf16len(text.slice(0,span.start)),
      length:utf16len(span.text)
    });
  }
  return entities;
}

function slashCommand(name){
  const raw=String(name||'').trim().replace(/^[./]+/,'');
  return '/'+(raw?raw[0].toUpperCase()+raw.slice(1):'');
}

function commandText(lines,bullet='• '){
  let text='',spans=[];
  for(const line of lines){
    const command=slashCommand(line.name);
    text+=bullet;
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

async function menuArtwork(settings,styleId){
  const bound=Number(settings?.menuImageStyle||0)===Number(styleId)
    ?String(settings?.menuImageUrl||'').trim()
    :'';
  if(bound){
    const custom=await resolveInlinePhoto(bound);
    if(custom)return custom;
  }
  return resolveStyleImage(styleId,'');
}

function displayUser(account,settings){
  if(account?.username)return '@'+String(account.username).replace(/^@/,'');
  const full=[account?.firstName,account?.lastName].filter(Boolean).join(' ').trim();
  return full||localized(settings,'Utilisateur Telegram','Telegram User');
}

export async function menuModel({account,settings,commands,view='home',category=null}){
  const groups=commandsByCategory(commands);
  const style=await getStyle(settings.style||1);
  const owner=isOwnerId(account.telegramUserId);
  const visible=cmd=>!cmd.hidden&&(!cmd.ownerOnly||owner);
  const user=displayUser(account,settings);
  const rank=owner?'owner':account.premium?'premium':'user';
  const header=renderThemeHeader(style.id,{
    user,
    rank,
    prefix:settings.prefix||'.',
    count:commandStats(commands).tokens
  });
  let body=header,spans=[];
  const quoteRange={start:0,length:header.length};

  if(view==='category'&&category){
    const list=(groups[category]||[]).filter(visible);
    const label=toSmallCaps(CATEGORY_LABELS[category]||category);
    const themed=renderThemeCategory(style.id,label);
    body=header+'\n\n'+themed.title+'\n';
    body+=toSmallCaps(localized(settings,'Commandes','Commands'))+' • '+list.length+'\n\n';

    const visibleCommands=list.map(cmd=>({
      name:cmd.name,
      suffix:[
        cmd.privateOnly?'  · '+toSmallCaps(localized(settings,'Privé','Private')):'',
        cmd.groupOnly?(cmd.adminOnly?'  · '+toSmallCaps(localized(settings,'Groupe/Admin','Group/Admin')):'  · '+toSmallCaps(localized(settings,'Groupe','Group'))):'',
        cmd.premium&&!account.premium?'  · 👑 '+toSmallCaps('Premium'):''
      ].join('')
    }));
    const ct=commandText(visibleCommands,themed.bullet);
    const shift=body.length;
    body+=ct.text;
    spans.push(...ct.spans.map(x=>({...x,start:x.start+shift})));
    if(themed.footer)body+='\n'+themed.footer;
  }else{
    body=header;
  }

  const buttons=[];
  if(view==='home'){
    const cats=CATEGORY_ORDER.filter(cat=>(groups[cat]||[]).some(visible));
    for(let i=0;i<cats.length;i+=2){
      buttons.push(cats.slice(i,i+2).map(cat=>{
        const id=emojiId(CATEGORY_ICONS[cat]);
        const raw=BUTTON_LABELS[cat]||CATEGORY_LABELS[cat]||cat;
        const label=toSmallCaps(raw);
        return button((id?'':(FALLBACK_EMOJI[cat]||'')+' ')+label,'cat:'+cat,'primary',CATEGORY_ICONS[cat]);
      }));
    }
    buttons.push([button('🎨 '+toSmallCaps(localized(settings,'Styles','Styles')),'menu:styles','primary','style')]);

    const primaryLinks=[];
    if(cfg.nextechUrl)primaryLinks.push(urlButton('ɴᴇxᴛᴇᴄʜ',cfg.nextechUrl,'success','nextech'));
    if(cfg.nexnewsUrl)primaryLinks.push(urlButton('ɴᴇxɴᴇᴡѕ',cfg.nexnewsUrl,'success','news'));
    if(primaryLinks.length)buttons.push(primaryLinks);
    if(cfg.darkUniverseUrl)buttons.push([urlButton('ᴅᴀʀᴋ ᴜɴɪᴠᴇʀѕᴇ',cfg.darkUniverseUrl,'success','dark')]);
  }else{
    buttons.push([button('↩ '+toSmallCaps(localized(settings,'Menu','Menu')),'menu:home','primary','back')]);
  }

  const text=body.trim();
  return {
    text,
    entities:expandableEntities(text,spans,quoteRange),
    reply_markup:{inline_keyboard:buttons},
    // Long category lists cannot fit in a Telegram photo caption. Keep artwork
    // attached to home/styles and use a single full text message for categories.
    photoUrl:view==='category'?'':await menuArtwork(settings,style.id)
  };
}

export async function stylesModel({account,settings}){
  const styles=(await listStyles()).filter(s=>s.id>0);
  let text='🔮 ɴᴇxᴀɪ • ᴅɪᴘᴘᴇʀ • ѕᴛʏʟᴇѕ\n\n',spans=[];
  for(const s of styles){
    const command='/Style'+s.id;
    const start=text.length;
    text+=command;
    spans.push({start,text:command});
    text+=' • '+toSmallCaps(s.name)+(Number(settings.style)===s.id?' • '+toSmallCaps(localized(settings,'Actif','Active')):'')+'\n';
  }
  text+='\n'+toSmallCaps(localized(settings,'Choisis un style ci-dessous ou utilise /Style<numéro>.','Choose a style below or use /Style<number>.'))+
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
