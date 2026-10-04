import { cfg, isOwnerId } from './config.mjs';
import { CATEGORY_ICONS, CATEGORY_LABELS, CATEGORY_ORDER, commandsByCategory, commandStats } from './commands.mjs';
import { getStyle, listStyles, resolveInlinePhoto, resolveStyleImage, toSmallCaps } from './styles.mjs';
import { renderThemeHeader, renderThemeCategory, themeUi } from './theme-ui.mjs';
import { animatedCustomEmojiEntitySpecs, sanitizeAnimatedEmojiText } from './response-ui.mjs';
import { customStyleEnabled, customStyleFor, customStyleMedia, dominantEmoji, renderCustomHeader, renderCustomCategory } from './custom-style.mjs';

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
const BUTTON_EMOJI_FALLBACK={
  general:'🏠',account:'👤',ai:'🧠',download:'📥',group:'👥',shield:'🔒',
  tools:'🛠️',media:'🎞️',sticker:'🎴',games:'🎮',search:'🔎',anime:'🌸',
  premium:'👑',owner:'🔮',nextech:'⚡',news:'📰',dark:'🕯️',back:'↩️',style:'🎨',next:'➡️',custom_style:'🎨'
};

function fallbackEmojiForIcon(icon){
  const key=String(icon||'').toLowerCase();
  if(/^style_\d+$/.test(key)){
    const id=Number(key.slice('style_'.length));
    return STYLE_EMOJI_FALLBACK[id]||'';
  }
  return BUTTON_EMOJI_FALLBACK[key]||'';
}

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

function premiumCommands(commands){
  const out=[],seen=new Set();
  for(const cmd of commands.values()){
    if(cmd.hidden||(!cmd.nexaiPremium&&!cmd.telegramPremium&&!cmd.premium))continue;
    const canonical=cmd.aliasFor||cmd.name;
    if(seen.has(canonical))continue;
    seen.add(canonical);
    out.push({...cmd,name:canonical});
  }
  return out.sort((a,b)=>a.name.localeCompare(b.name));
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

export async function menuModel({account,settings,commands,view='home',category=null,page=0,includeArtwork=true}){
  const groups=commandsByCategory(commands);
  const style=await getStyle(settings.style||1);
  const owner=isOwnerId(account.telegramUserId);
  const custom=customStyleFor(settings);
  const customEnabled=customStyleEnabled(settings);
  const media=includeArtwork?customStyleMedia(settings):null;
  const activeTheme=themeUi(style.id);
  const menuButtonStyle=customEnabled?custom.buttonStyle:(activeTheme.buttonStyle||'primary');
  const visible=cmd=>!cmd.hidden&&(!cmd.ownerOnly||owner);
  const user=displayUser(account,settings);
  const telegramPremium=account.telegramPremium===true||account.premium===true;
  const nexaiPremium=owner||account.nexaiPremium===true;
  const rank=owner?'owner':nexaiPremium?'NEXAI PREMIUM':telegramPremium?'TG PREMIUM':'user';
  const headerData={
    botName:String(settings.botDisplayName||'NEXAI').slice(0,32),
    user,
    rank,
    prefix:settings.prefix||'.',
    count:commandStats(commands).canonical
  };
  const header=sanitizeAnimatedEmojiText(
    customEnabled?renderCustomHeader(settings,headerData):renderThemeHeader(style.id,headerData),
    settings?.customEmojiIds||{}
  );
  let body=header,spans=[];
  let categoryPage=null;
  const quoteRange={start:0,length:header.length};

  if(view==='category'&&category){
    const allList=(category==='PREMIUM'?premiumCommands(commands):(groups[category]||[])).filter(visible);
    const mediaPageSize=8;
    const pageCount=media?Math.max(1,Math.ceil(allList.length/mediaPageSize)):1;
    const safePage=media?Math.max(0,Math.min(pageCount-1,Number(page)||0)):0;
    const list=media?allList.slice(safePage*mediaPageSize,(safePage+1)*mediaPageSize):allList;
    if(media)categoryPage={page:safePage,count:pageCount,total:allList.length};
    const label=toSmallCaps(CATEGORY_LABELS[category]||category);
    const categoryGlyph=customEnabled?dominantEmoji(settings,'category:'+category):(FALLBACK_EMOJI[category]||'');
    const themedLabel=(categoryGlyph||'')+(categoryGlyph?' ':'')+label;
    const themed=customEnabled?renderCustomCategory(settings,themedLabel):renderThemeCategory(style.id,themedLabel);
    const themedTitle=sanitizeAnimatedEmojiText(themed.title,settings?.customEmojiIds||{});
    const themedBullet=sanitizeAnimatedEmojiText(themed.bullet,settings?.customEmojiIds||{});
    const themedFooter=sanitizeAnimatedEmojiText(themed.footer,settings?.customEmojiIds||{});
    body=header+'\n'+themedTitle+'\n';
    body+=toSmallCaps(localized(settings,'Commandes','Commands'))+' • '+(media?allList.length:list.length)+'\n';
    if(categoryPage&&categoryPage.count>1){
      body+=toSmallCaps(localized(settings,'Page','Page'))+' '+(categoryPage.page+1)+'/'+categoryPage.count+'\n';
    }
    if(category==='PREMIUM'){
      body+=toSmallCaps(localized(
        settings,
        'NexAI Premium : '+(nexaiPremium?'ACTIF':'INACTIF')+' • 250 ⭐ / 30 jours',
        'NexAI Premium: '+(nexaiPremium?'ACTIVE':'INACTIVE')+' • 250 ⭐ / 30 days'
      ))+'\n';
      body+=toSmallCaps(localized(
        settings,
        'Telegram Premium : '+(telegramPremium?'ACTIF':'INACTIF'),
        'Telegram Premium: '+(telegramPremium?'ACTIVE':'INACTIVE')
      ))+'\n';
      body+=toSmallCaps(localized(
        settings,
        'Take / Clonepack Free : 2 utilisations tous les 3 jours',
        'Take / Clonepack Free: 2 uses every 3 days'
      ))+'\n\n';
    }

    const visibleCommands=list.map(cmd=>({
      name:cmd.name,
      suffix:[
        cmd.privateOnly?'  · '+toSmallCaps(localized(settings,'Privé','Private')):'',
        cmd.groupOnly?(cmd.adminOnly?'  · '+toSmallCaps(localized(settings,'Groupe/Admin','Group/Admin')):'  · '+toSmallCaps(localized(settings,'Groupe','Group'))):'',
        (cmd.telegramPremium||cmd.premium)
          ?'  · 👑 ('+toSmallCaps('Telegram Premium')+')'
          :'',
        cmd.nexaiPremium
          ?'  · 👑 ('+toSmallCaps('Premium')+')'
          :''
      ].join('')
    }));
    const ct=commandText(visibleCommands,themedBullet);
    const shift=body.length;
    body+=ct.text;
    spans.push(...ct.spans.map(x=>({...x,start:x.start+shift})));
    if(themedFooter)body+=themedFooter;
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
        return button(label,'cat:'+cat,menuButtonStyle,CATEGORY_ICONS[cat],settings);
      }));
    }
    buttons.push([
      button(toSmallCaps(localized(settings,'Styles','Styles')),'menu:styles',menuButtonStyle,'style',settings),
      button(toSmallCaps(localized(settings,'Mon style','My style')),'menu:customstyle',menuButtonStyle,'custom_style',settings)
    ]);

    const primaryLinks=[];
    if(cfg.nextechUrl)primaryLinks.push(urlButton('ɴᴇxᴛᴇᴄʜ',cfg.nextechUrl,'success','nextech',settings));
    if(cfg.nexnewsUrl)primaryLinks.push(urlButton('ɴᴇxɴᴇᴡѕ',cfg.nexnewsUrl,'success','news',settings));
    if(primaryLinks.length)buttons.push(primaryLinks);
    if(cfg.darkUniverseUrl)buttons.push([urlButton('ᴅᴀʀᴋ ᴜɴɪᴠᴇʀѕᴇ',cfg.darkUniverseUrl,'success','dark',settings)]);
  }else{
    if(categoryPage&&categoryPage.count>1){
      const nav=[];
      if(categoryPage.page>0)nav.push(button('‹ '+toSmallCaps(localized(settings,'Précédent','Previous')),'cat:'+category+':'+(categoryPage.page-1),'primary','back',settings));
      if(categoryPage.page<categoryPage.count-1)nav.push(button(toSmallCaps(localized(settings,'Suivant','Next'))+' ›','cat:'+category+':'+(categoryPage.page+1),'primary','next',settings));
      if(nav.length)buttons.push(nav);
    }
    if(category==='PREMIUM'&&!nexaiPremium){
      buttons.push([button(toSmallCaps(localized(settings,'Activer NexAI Premium · 250 ⭐','Activate NexAI Premium · 250 ⭐')),'premium:buy','success','premium',settings)]);
    }
    buttons.push([button(toSmallCaps(localized(settings,'Menu','Menu')),'menu:home','primary','back',settings)]);
    if(cfg.nextechUrl)buttons.push([urlButton('ɴᴇxᴛᴇᴄʜ',cfg.nextechUrl,'success','nextech',settings)]);
  }

  const text=body.trim();
  return {
    text,
    entities:[
      ...expandableEntities(text,spans,quoteRange),
      ...animatedCustomEmojiEntitySpecs(text,settings?.customEmojiIds||{})
    ],
    reply_markup:{inline_keyboard:buttons},
    // Built-in themes keep the editable text + link-preview architecture.
    // A personal photo/video is a Telegram cached media file, so media-mode
    // categories are paginated above to remain safely under caption limits.
    photoUrl:media?'':(includeArtwork?await menuArtwork(settings,style.id):''),
    media
  };
}

export async function stylesModel({account,settings}){
  const styles=(await listStyles()).filter(s=>s.id>0);
  const displayName=toSmallCaps(String(settings?.botDisplayName||'NEXAI').slice(0,32));
  const media=customStyleMedia(settings);
  const custom=customStyleFor(settings);
  let text='🔮 '+displayName+' • ᴅɪᴘᴘᴇʀ • ѕᴛʏʟᴇѕ\n\n',spans=[];
  if(media){
    text+=toSmallCaps(localized(settings,'Style personnel actif','Personal style active'))+' • '+custom.name+'\n';
    text+=custom.emojis.join(' ')+'\n\n';
    text+=toSmallCaps(localized(settings,'Choisis une base ci-dessous ou ouvre Mon style pour la modifier.','Choose a base below or open My style to edit it.'));
  }else{
    for(const s of styles){
      const command='/Style'+s.id;
      const start=text.length;
      text+=command;
      spans.push({start,text:command});
      text+=' • '+toSmallCaps(s.name)+(Number(settings.style)===s.id?' • '+toSmallCaps(localized(settings,'Actif','Active')):'')+'\n';
    }
    text+='\n'+toSmallCaps(localized(settings,'Choisis un style ci-dessous ou utilise /Style<numéro>.','Choose a style below or use /Style<number>.'))+
      '\n♛ '+displayName+' • ᴅɪᴘᴘᴇʀ × ɴᴇxᴛᴇᴄʜ ♛';
  }

  const keyboard=[];
  for(let i=0;i<styles.length;i+=2){
    keyboard.push(styles.slice(i,i+2).map(s=>{
      const active=Number(settings.style)===s.id;
      const short=STYLE_BUTTON_LABELS[s.id]||s.name;
      const icon='style_'+s.id;
      const prefix=(active?'✓ ':'');
      return button(prefix+String(s.id).padStart(2,'0')+' · '+toSmallCaps(short),'style:set:'+s.id,active?'success':'primary',icon,settings);
    }));
  }
  keyboard.push([button(toSmallCaps(localized(settings,'Mon style','My style')),'menu:customstyle',custom.enabled?'success':'primary','custom_style',settings)]);
  keyboard.push([button(toSmallCaps(localized(settings,'Menu','Menu')),'menu:home','primary','back',settings)]);
  if(cfg.nextechUrl)keyboard.push([urlButton('ɴᴇxᴛᴇᴄʜ',cfg.nextechUrl,'success','nextech',settings)]);

  return {
    text,
    entities:[
      ...expandableEntities(text,spans),
      ...animatedCustomEmojiEntitySpecs(text,settings?.customEmojiIds||{})
    ],
    reply_markup:{inline_keyboard:keyboard},
    photoUrl:media?'':await menuArtwork(settings,settings.style||1),
    media
  };
}

export async function customStyleModel({account,settings}){
  const style=customStyleFor(settings);
  const media=customStyleMedia(settings);
  const prefix=String(settings?.prefix||'.');
  const enabled=style.enabled===true;
  const lang=String(settings?.language||'fr').toLowerCase().startsWith('en')?'en':'fr';
  const text=(lang==='en'?[ 
    '🎨 '+toSmallCaps('My NexAI style'),
    '',
    'Status • '+(enabled?'ON':'OFF'),
    'Name • '+style.name,
    'Bot • '+String(settings?.botDisplayName||'NexAi'),
    'Emojis • '+style.emojis.join(' '),
    'Media • '+(style.media.type||'none'),
    'Buttons • '+style.buttonStyle,
    style.tagline?'Tagline • '+style.tagline:'',
    '',
    '/customstyle on · /customstyle off · /customstyle reset',
    '/botname <name> · /stylename <name>',
    '/styleemoji ✨ ⚡ 🖤 · /styletagline <text>',
    '/stylebuttons primary|success|danger',
    '/menuphoto (reply to a photo)',
    '/menuvideo (reply to a video) · /menumedia off',
    '',
    'Connected-account prefix • '+prefix
  ]:[
    '🎨 '+toSmallCaps('Mon style NexAI'),
    '',
    'État • '+(enabled?'ON':'OFF'),
    'Nom • '+style.name,
    'Bot • '+String(settings?.botDisplayName||'NexAi'),
    'Emojis • '+style.emojis.join(' '),
    'Média • '+(style.media.type||'aucun'),
    'Boutons • '+style.buttonStyle,
    style.tagline?'Signature • '+style.tagline:'',
    '',
    '/customstyle on · /customstyle off · /customstyle reset',
    '/botname <nom> · /stylename <nom>',
    '/styleemoji ✨ ⚡ 🖤 · /styletagline <texte>',
    '/stylebuttons primary|success|danger',
    '/menuphoto (réponds à une photo)',
    '/menuvideo (réponds à une vidéo) · /menumedia off',
    '',
    'Préfixe du compte connecté • '+prefix
  ]).filter(Boolean).join('\n');
  const buttons=[
    [
      button(toSmallCaps(lang==='en'?'Enable':'Activer'),'custom:on',enabled?'success':'primary','custom_style',settings),
      button(toSmallCaps(lang==='en'?'Disable':'Désactiver'),'custom:off',!enabled?'success':'danger','back',settings)
    ],
    [button(toSmallCaps(lang==='en'?'Preview menu':'Aperçu menu'),'menu:home','primary','general',settings)],
    [button(toSmallCaps(lang==='en'?'Built-in styles':'Styles NexAI'),'menu:styles','primary','style',settings)]
  ];
  return {
    text:text.slice(0,1000),
    entities:[...animatedCustomEmojiEntitySpecs(text.slice(0,1000),settings?.customEmojiIds||{})],
    reply_markup:{inline_keyboard:buttons},
    photoUrl:'',
    media
  };
}

function emojiId(logical,settings=null){
  const key='NEXAI_EMOJI_'+String(logical||'').toUpperCase().replace(/[^A-Z0-9]+/g,'_');
  const session=String(settings?.customEmojiIds?.[key]||'').trim();
  return /^\d{5,30}$/.test(session)?session:undefined;
}

function button(text,data,style='primary',icon,settings=null){
  const id=emojiId(icon,settings);
  const customFallback=dominantEmoji(settings,String(icon||data||text));
  const fallback=!id?(customFallback||fallbackEmojiForIcon(icon)):'';
  const b={text:(fallback?fallback+' ':'')+String(text),callback_data:data,style};
  if(id)b.icon_custom_emoji_id=id;
  return b;
}

function urlButton(text,url,style='success',icon,settings=null){
  const id=emojiId(icon,settings);
  const customFallback=dominantEmoji(settings,String(icon||url||text));
  const fallback=!id?(customFallback||fallbackEmojiForIcon(icon)):'';
  const b={text:(fallback?fallback+' ':'')+String(text),url,style};
  if(id)b.icon_custom_emoji_id=id;
  return b;
}
