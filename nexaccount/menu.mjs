import { cfg, isOwnerId } from './config.mjs';
import { CATEGORY_ICONS, CATEGORY_LABELS, CATEGORY_ORDER, commandsByCategory, commandStats } from './commands.mjs';
import { getStyle, listStyles, resolveInlinePhoto, resolveStyleImage, toSmallCaps } from './styles.mjs';
import { renderThemeHeader, renderThemeCategory, themeUi } from './theme-ui.mjs';

const utf16len=s=>Buffer.from(String(s),'utf16le').length/2;
const FALLBACK_EMOJI={
  GENERAL:'🏠',ACCOUNT:'👤',AI:'🧠',DOWNLOAD:'📥',GROUP:'👥',ADMIN:'🛡️',
  PROTECTION:'🔒',TOOLS:'🛠️',MEDIA:'🎞️',STICKERS:'🎴',FUN:'🎮',ANIME:'🌸',
  SEARCH:'🔎',PREMIUM:'👑',OWNER:'🔮'
};
const BUTTON_LABELS={
  GENERAL:'MAIN',
  ACCOUNT:'ACCOUNT',
  AI:'AI / CHAT',
  DOWNLOAD:'DOWNLOAD',
  GROUP:'GROUP',
  PROTECTION:'PROTECT',
  TOOLS:'TOOLS',
  MEDIA:'MEDIA',
  STICKERS:'STICKER',
  FUN:'FUN / GAME',
  SEARCH:'SEARCH',
  ANIME:'ANIME',
  PREMIUM:'PREMIUM',
  OWNER:'OWNER'
};
const STYLE_BUTTON_LABELS={
  1:'DARK',2:'NARUTO',3:'SHADOW',4:'HACKER',5:'MANHWA',6:'AI',7:'RUBY',8:'GOJO',
  9:'OREKI',10:'MARIN',11:'JIN-WOO',12:'MADARA',13:'AIZEN',14:'LELOUCH',15:'EREN',
  16:'ITACHI',17:'YHWACH',18:'BUSINESS',19:'MERCHANT',20:'PURGE',21:'MIO',22:'NAZUNA',
  23:'WAGURI',24:'ALYA',25:'ANNA',26:'HOSHINA',27:'BACHIRA',28:'RIN',29:'POWER',
  30:'SHINOBU',31:'BENIMARU'
};
const STYLE_EMOJI_FALLBACK={
  1:'🕯',2:'🍃',3:'🕶️',4:'💻',5:'⚔️',6:'⭐',7:'🌸',8:'👁',9:'🌿',10:'🎀',
  11:'🗡',12:'👁',13:'🪷',14:'👁',15:'⚔',16:'👁',17:'👑',18:'📊',19:'🌒',
  20:'☄',21:'🌙',22:'🦇',23:'🌸',24:'❄',25:'🍫',26:'⚔',27:'⚽',28:'🎯',
  29:'🩸',30:'🦋',31:'⛩'
};

export function expandableEntities(text,commandSpans=[],quoteRange=null,customEmojiSpans=[]){
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
  for(const span of customEmojiSpans){
    if(!span?.text||!span?.custom_emoji_id||Number(span.start)<0)continue;
    entities.push({
      type:'custom_emoji',
      offset:utf16len(text.slice(0,span.start)),
      length:utf16len(span.text),
      custom_emoji_id:String(span.custom_emoji_id)
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

function emojiEntitySpans(text,glyph,id){
  if(!glyph||!id)return [];
  const value=String(text);
  const out=[];
  let from=0;
  while(true){
    const start=value.indexOf(glyph,from);
    if(start<0)break;
    out.push({start,text:glyph,custom_emoji_id:id});
    from=start+glyph.length;
  }
  return out;
}

function themeCustomEmojiSpans(text,styleId,category=null,settings=null){
  const out=[];
  const glyph=STYLE_EMOJI_FALLBACK[Number(styleId)];
  out.push(...emojiEntitySpans(text,glyph,emojiId('style_'+Number(styleId),settings)));
  if(category){
    const catGlyph=FALLBACK_EMOJI[category];
    // Telegram rejects overlapping MessageEntityCustomEmoji ranges. When the
    // character theme and the category intentionally use the same glyph (for
    // example Ruby + Anime = 🌸), keep the theme entity instead of stacking two.
    if(catGlyph&&catGlyph!==glyph){
      out.push(...emojiEntitySpans(text,catGlyph,emojiId(CATEGORY_ICONS[category],settings)));
    }
  }
  return out;
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

export async function menuModel({account,settings,commands,view='home',category=null,includeArtwork=true}){
  const groups=commandsByCategory(commands);
  const style=await getStyle(settings.style||1);
  const owner=isOwnerId(account.telegramUserId);
  const activeTheme=themeUi(style.id);
  const menuButtonStyle=activeTheme.buttonStyle||'primary';
  const visible=cmd=>!cmd.hidden&&(!cmd.ownerOnly||owner);
  const user=displayUser(account,settings);
  const rank=owner?'owner':account.premium?'premium':'user';
  const header=renderThemeHeader(style.id,{
    botName:String(settings.botDisplayName||'NEXAI').slice(0,32),
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
    const themedLabel=(FALLBACK_EMOJI[category]||'')+(FALLBACK_EMOJI[category]?' ':'')+label;
    const themed=renderThemeCategory(style.id,themedLabel);
    body=header+'\n'+themed.title+'\n';
    body+=toSmallCaps(localized(settings,'Commandes','Commands'))+' • '+list.length+'\n';

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
    if(themed.footer)body+=themed.footer;
  }else{
    body=header;
  }

  const buttons=[];
  if(view==='home'){
    const cats=CATEGORY_ORDER.filter(cat=>(groups[cat]||[]).some(visible));
    for(let i=0;i<cats.length;i+=2){
      buttons.push(cats.slice(i,i+2).map(cat=>{
        const id=emojiId(CATEGORY_ICONS[cat],settings);
        const raw=BUTTON_LABELS[cat]||CATEGORY_LABELS[cat]||cat;
        const label=toSmallCaps(raw);
        return button((id?'':(FALLBACK_EMOJI[cat]||'')+' ')+label,'cat:'+cat,menuButtonStyle,CATEGORY_ICONS[cat],settings);
      }));
    }
    buttons.push([button((emojiId('style',settings)?'':'🎨 ')+toSmallCaps(localized(settings,'Styles','Styles')),'menu:styles',menuButtonStyle,'style',settings)]);

    const primaryLinks=[];
    if(cfg.nextechUrl)primaryLinks.push(urlButton('ɴᴇxᴛᴇᴄʜ',cfg.nextechUrl,'success','nextech',settings));
    if(cfg.nexnewsUrl)primaryLinks.push(urlButton('ɴᴇxɴᴇᴡѕ',cfg.nexnewsUrl,'success','news',settings));
    if(primaryLinks.length)buttons.push(primaryLinks);
    if(cfg.darkUniverseUrl)buttons.push([urlButton('ᴅᴀʀᴋ ᴜɴɪᴠᴇʀѕᴇ',cfg.darkUniverseUrl,'success','dark',settings)]);
  }else{
    buttons.push([button((emojiId('back',settings)?'':'↩ ')+toSmallCaps(localized(settings,'Menu','Menu')),'menu:home','primary','back',settings)]);
  }

  const text=body.trim();
  return {
    text,
    entities:expandableEntities(text,spans,quoteRange,themeCustomEmojiSpans(text,style.id,view==='category'?category:null,settings)),
    reply_markup:{inline_keyboard:buttons},
    // Artwork is a link preview above an editable text message, so categories
    // keep the same image/header alignment without the 1024-char media-caption limit.
    photoUrl:includeArtwork?await menuArtwork(settings,style.id):''
  };
}

export async function stylesModel({account,settings}){
  const styles=(await listStyles()).filter(s=>s.id>0);
  const displayName=toSmallCaps(String(settings?.botDisplayName||'NEXAI').slice(0,32));
  let text='🔮 '+displayName+' • ᴅɪᴘᴘᴇʀ • ѕᴛʏʟᴇѕ\n\n',spans=[];
  for(const s of styles){
    const command='/Style'+s.id;
    const start=text.length;
    text+=command;
    spans.push({start,text:command});
    text+=' • '+toSmallCaps(s.name)+(Number(settings.style)===s.id?' • '+toSmallCaps(localized(settings,'Actif','Active')):'')+'\n';
  }
  text+='\n'+toSmallCaps(localized(settings,'Choisis un style ci-dessous ou utilise /Style<numéro>.','Choose a style below or use /Style<number>.'))+
    '\n♛ '+displayName+' • ᴅɪᴘᴘᴇʀ × ɴᴇxᴛᴇᴄʜ ♛';

  const keyboard=[];
  for(let i=0;i<styles.length;i+=2){
    keyboard.push(styles.slice(i,i+2).map(s=>{
      const active=Number(settings.style)===s.id;
      const short=STYLE_BUTTON_LABELS[s.id]||s.name;
      const icon='style_'+s.id;
      const prefix=(active?'✓ ':'')+(emojiId(icon,settings)?'':(STYLE_EMOJI_FALLBACK[s.id]||'✦')+' ');
      return button(prefix+String(s.id).padStart(2,'0')+' · '+toSmallCaps(short),'style:set:'+s.id,active?'success':'primary',icon,settings);
    }));
  }
  keyboard.push([button((emojiId('back',settings)?'':'↩ ')+toSmallCaps(localized(settings,'Menu','Menu')),'menu:home','primary','back',settings)]);

  return {
    text,
    entities:expandableEntities(text,spans),
    reply_markup:{inline_keyboard:keyboard},
    photoUrl:await menuArtwork(settings,settings.style||1)
  };
}

function emojiId(logical,settings=null){
  const key='NEXAI_EMOJI_'+String(logical||'').toUpperCase().replace(/[^A-Z0-9]+/g,'_');
  const session=String(settings?.customEmojiIds?.[key]||'').trim();
  return session||String(process.env[key]||'').trim()||undefined;
}

function button(text,data,style='primary',icon,settings=null){
  const b={text,callback_data:data,style};
  const id=emojiId(icon,settings);
  if(id)b.icon_custom_emoji_id=id;
  return b;
}

function urlButton(text,url,style='success',icon,settings=null){
  const b={text,url,style};
  const id=emojiId(icon,settings);
  if(id)b.icon_custom_emoji_id=id;
  return b;
}
