import { cfg } from './config.mjs';
import { CATEGORY_ICONS, CATEGORY_LABELS, CATEGORY_ORDER, commandsByCategory } from './commands.mjs';
import { getStyle, listStyles, renderDipperHeader, resolveStyleImage } from './styles.mjs';

const utf16len=s=>Buffer.from(String(s),'utf16le').length/2;

export function expandableEntities(text,commandSpans=[]){
  const entities=[{type:'expandable_blockquote',offset:0,length:utf16len(text)}];
  for(const span of commandSpans){
    entities.push({type:'bot_command',offset:utf16len(text.slice(0,span.start)),length:utf16len(span.text)});
  }
  return entities;
}

function commandText(lines){
  let text='',spans=[];
  for(const line of lines){
    const command='/'+line.name;
    const start=text.length;
    text+=command;
    spans.push({start,text:command});
    if(line.suffix)text+=line.suffix;
    text+='\n';
  }
  return {text,spans};
}

export async function menuModel({account,settings,commands,view='home',category=null}){
  const groups=commandsByCategory(commands);
  const style=await getStyle(settings.style||1);
  const header=await renderDipperHeader(style.id,{
    botName:'NEXAI',
    ownerName:account.username?'@'+account.username:(account.firstName||'Utilisateur'),
    rank:account.premium?'premium':'utilisateur',
    prefix:settings.prefix||'.',
    count:commands.size
  });
  let body=header,spans=[];
  if(view==='category'&&category){
    const list=(groups[category]||[]).filter(c=>!c.ownerOnly);
    body+='\n'+(CATEGORY_LABELS[category]||category)+'\n\n';
    const visible=list.map(c=>({name:c.name,suffix:c.premium&&!account.premium?'  · Premium':''}));
    const ct=commandText(visible);
    const shift=body.length;
    body+=ct.text;
    spans.push(...ct.spans.map(x=>({...x,start:x.start+shift})));
  }else{
    if(style.tagline)body+='\n'+style.tagline+'\n';
  }
  if(style.exactFooter){
    try{body+='\n'+style.exactFooter()}catch{}
  }
  body+='\nPowered by Nextech';
  const buttons=[];
  if(view==='home'){
    const cats=CATEGORY_ORDER.filter(cat=>(groups[cat]||[]).some(c=>!c.ownerOnly));
    for(let i=0;i<cats.length;i+=2){
      buttons.push(cats.slice(i,i+2).map(cat=>button(CATEGORY_LABELS[cat]||cat,'cat:'+cat,'primary',CATEGORY_ICONS[cat])));
    }
    const links=[];
    if(cfg.nextechUrl)links.push(urlButton('Nextech',cfg.nextechUrl,'success','nextech'));
    if(cfg.nexnewsUrl)links.push(urlButton('NexNews',cfg.nexnewsUrl,'success','news'));
    if(cfg.darkUniverseUrl)links.push(urlButton('Dark Universe',cfg.darkUniverseUrl,'success','dark'));
    if(links.length)buttons.push(links);
  }else{
    buttons.push([button('MENU','menu:home','primary','back')]);
  }
  const text=body.trim();
  return {
    text,
    entities:expandableEntities(text,spans),
    reply_markup:{inline_keyboard:buttons},
    photoUrl:await resolveStyleImage(style.id,cfg.defaultMenuImage)
  };
}

export async function stylesModel({account,settings}){
  const styles=(await listStyles()).filter(s=>s.id>0);
  let text='NEXAI · STYLES\n\n',spans=[];
  for(const s of styles){
    const command='/style'+s.id;
    const start=text.length;
    text+=command;
    spans.push({start,text:command});
    text+=' · '+s.name+(Number(settings.style)===s.id?' · ACTIF':'')+'\n';
  }
  text+='\nTu peux aussi utiliser .style <numéro>.\nPowered by Nextech';
  return {
    text,
    entities:expandableEntities(text,spans),
    reply_markup:{inline_keyboard:[[button('MENU','menu:home','primary','back')]]},
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
