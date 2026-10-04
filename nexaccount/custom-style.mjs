const BUTTON_STYLES=new Set(['primary','success','danger']);

export const DEFAULT_CUSTOM_STYLE=Object.freeze({
  enabled:false,
  name:'Mon style',
  emojis:['✨','⚡','🖤'],
  tagline:'',
  buttonStyle:'primary',
  media:{type:'',fileId:'',fileUniqueId:''}
});

function cleanText(value,max,fallback=''){
  const text=String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  return (text||fallback).slice(0,max);
}

function cleanEmoji(value){
  const text=String(value??'').trim().slice(0,20);
  if(!text)return '';
  try{
    if(!/\p{Extended_Pictographic}/u.test(text)&&!/\p{Emoji_Presentation}/u.test(text))return '';
  }catch{
    if(!/[^\x00-\x7F]/.test(text))return '';
  }
  return text;
}

export function normalizeCustomStyle(value={}){
  const raw=value&&typeof value==='object'?value:{};
  const mediaRaw=raw.media&&typeof raw.media==='object'?raw.media:{};
  const mediaType=['photo','video'].includes(String(mediaRaw.type||'').toLowerCase())
    ?String(mediaRaw.type).toLowerCase()
    :'';
  const fileId=cleanText(mediaRaw.fileId,512,'');
  const fileUniqueId=cleanText(mediaRaw.fileUniqueId,256,'');
  const emojis=[...new Set((Array.isArray(raw.emojis)?raw.emojis:[])
    .map(cleanEmoji)
    .filter(Boolean))]
    .slice(0,6);
  return {
    enabled:raw.enabled===true,
    name:cleanText(raw.name,32,DEFAULT_CUSTOM_STYLE.name),
    emojis:emojis.length?emojis:[...DEFAULT_CUSTOM_STYLE.emojis],
    tagline:cleanText(raw.tagline,96,''),
    buttonStyle:BUTTON_STYLES.has(String(raw.buttonStyle||'').toLowerCase())
      ?String(raw.buttonStyle).toLowerCase()
      :DEFAULT_CUSTOM_STYLE.buttonStyle,
    media:{
      type:mediaType&&fileId?mediaType:'',
      fileId:mediaType&&fileId?fileId:'',
      fileUniqueId:mediaType&&fileId?fileUniqueId:''
    }
  };
}

export function customStyleFor(settings={}){
  return normalizeCustomStyle(settings?.customStyle||{});
}

export function customStyleEnabled(settings={}){
  return customStyleFor(settings).enabled===true;
}

export function customStyleMedia(settings={}){
  const style=customStyleFor(settings);
  if(!style.enabled||!style.media.type||!style.media.fileId)return null;
  return {...style.media};
}

export function dominantEmoji(settings={},key=''){
  const style=customStyleFor(settings);
  if(!style.enabled||!style.emojis.length)return '';
  const source=String(key||'main');
  let hash=0;
  for(let i=0;i<source.length;i++)hash=(hash*31+source.charCodeAt(i))>>>0;
  return style.emojis[hash%style.emojis.length]||style.emojis[0]||'';
}

export function renderCustomHeader(settings={},data={}){
  const style=customStyleFor(settings);
  const emojis=style.emojis.length?style.emojis:DEFAULT_CUSTOM_STYLE.emojis;
  const e=i=>emojis[i%emojis.length]||'✦';
  const bot=cleanText(data.botName,32,'NEXAI');
  const user=cleanText(data.user,64,'Telegram User');
  const rank=cleanText(data.rank,32,'USER').toUpperCase();
  const prefix=cleanText(data.prefix,4,'.');
  const count=Math.max(0,Number(data.count)||0);
  const lines=[
    e(0)+'〔 '+bot+' 〕',
    '┃ '+e(1)+' '+user,
    '┃ '+e(2)+' RANK • '+rank,
    '┃ '+e(0)+' PREFIX • [ '+prefix+' ]',
    '┃ '+e(1)+' COMMANDS • '+count
  ];
  if(style.tagline)lines.push('╰'+e(2)+' '+style.tagline);
  else lines.push('╰'+e(2)+' CUSTOM STYLE');
  return lines.join('\n');
}

export function renderCustomCategory(settings={},label='MAIN'){
  const style=customStyleFor(settings);
  const emojis=style.emojis.length?style.emojis:DEFAULT_CUSTOM_STYLE.emojis;
  const first=emojis[0]||'✦';
  const second=emojis[1]||first;
  const third=emojis[2]||second;
  return {
    title:first+'〔 '+String(label||'MAIN')+' 〕',
    bullet:second+' ',
    footer:'╰'+third+' '+style.name
  };
}
