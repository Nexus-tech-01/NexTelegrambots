import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  proto,
  prepareWAMessageMedia,
  generateWAMessageFromContent
} from '@whiskeysockets/baileys';

const ACCENT = '#25e6ff';
const GREEN = '#5cffb0';
const ORANGE = '#ffb357';
const PURPLE = '#b47cff';
const BG = '#050812';
const PANEL = '#0b1220';

function esc(value='') {
  return String(value)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&apos;');
}

function safeCategory(value='') {
  const v = String(value || '').trim().toUpperCase();
  return ['GENERAL','GROUP','MEDIA','TOOLS'].includes(v) ? v : '';
}

function shortUser(jid='') {
  const n = String(jid).split('@')[0].replace(/\D/g,'');
  return n ? '@' + n.slice(-10) : '@user';
}

function commandLines(commands=[]) {
  const rows = [];
  for (let i=0;i<commands.length;i+=2) rows.push([commands[i] || '', commands[i+1] || '']);
  return rows;
}

function dashboardSvg({sender,rank,status,commandCount,categories}) {
  const cards = [
    ['GENERAL','Commandes & système',ACCENT],
    ['GROUP','Gestion des groupes',GREEN],
    ['MEDIA','Téléchargements & média',ORANGE],
    ['TOOLS','Outils & messages',PURPLE],
  ];
  let y = 455;
  const cardSvg = cards.map(([key,label,color],idx)=>{
    const count = Array.isArray(categories?.[key]) ? categories[key].length : 0;
    const sample = (categories?.[key] || []).slice(0,5).map(x=>'.'+x).join('  ');
    const out = `
      <g transform="translate(70 ${y})">
        <rect width="940" height="180" rx="34" fill="${PANEL}" stroke="${color}" stroke-opacity=".48" stroke-width="2"/>
        <rect x="0" y="0" width="12" height="180" rx="6" fill="${color}"/>
        <circle cx="82" cy="70" r="34" fill="${color}" fill-opacity=".14" stroke="${color}" stroke-width="2"/>
        <text x="82" y="82" text-anchor="middle" fill="${color}" font-size="30" font-weight="800">${String(idx+1).padStart(2,'0')}</text>
        <text x="140" y="62" fill="#ffffff" font-size="32" font-weight="800">${key}</text>
        <text x="140" y="101" fill="#91a4bd" font-size="21">${esc(label)}</text>
        <text x="850" y="64" text-anchor="end" fill="${color}" font-size="24" font-weight="800">${count}</text>
        <text x="140" y="143" fill="#5f7898" font-size="18">${esc(sample)}</text>
      </g>`;
    y += 205;
    return out;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1360">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#03050a"/>
        <stop offset=".55" stop-color="#071120"/>
        <stop offset="1" stop-color="#07111a"/>
      </linearGradient>
      <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="9" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <rect width="1080" height="1360" fill="url(#bg)"/>
    <circle cx="920" cy="110" r="170" fill="${ACCENT}" fill-opacity=".05"/>
    <circle cx="170" cy="1270" r="230" fill="${PURPLE}" fill-opacity=".04"/>
    <rect x="34" y="34" width="1012" height="1292" rx="48" fill="none" stroke="${ACCENT}" stroke-opacity=".2" stroke-width="2"/>
    <g transform="translate(70 72)">
      <text x="0" y="54" fill="${ACCENT}" font-size="28" font-weight="800" letter-spacing="8">NEXTECH // WHATSAPP</text>
      <text x="0" y="136" fill="#ffffff" font-size="76" font-weight="900">NEXAI</text>
      <text x="0" y="180" fill="#768aa5" font-size="25">CONTROL DECK • RICH INTERFACE</text>
      <rect x="0" y="222" width="940" height="145" rx="30" fill="${PANEL}" stroke="#15243b"/>
      <text x="34" y="266" fill="#6f849f" font-size="19">OPERATOR</text>
      <text x="34" y="310" fill="#ffffff" font-size="30" font-weight="700">${esc(shortUser(sender))}</text>
      <text x="330" y="266" fill="#6f849f" font-size="19">RANK</text>
      <text x="330" y="310" fill="${PURPLE}" font-size="30" font-weight="700">${esc(rank)}</text>
      <text x="600" y="266" fill="#6f849f" font-size="19">STATUS</text>
      <text x="600" y="310" fill="${GREEN}" font-size="30" font-weight="700">${esc(String(status).toUpperCase())}</text>
      <text x="815" y="266" fill="#6f849f" font-size="19">COMMANDS</text>
      <text x="815" y="310" fill="${ACCENT}" font-size="30" font-weight="800">${Number(commandCount)||0}</text>
    </g>
    ${cardSvg}
    <g transform="translate(70 1280)">
      <circle cx="10" cy="-3" r="6" fill="${GREEN}" filter="url(#glow)"/>
      <text x="30" y="5" fill="#61728a" font-size="18">LIVE • tap a button below the card</text>
      <text x="940" y="5" text-anchor="end" fill="#39506e" font-size="17">NEXAI / ELITE UI</text>
    </g>
  </svg>`;
}

function categorySvg({category,commands,sender,status}) {
  const palette = {GENERAL:ACCENT,GROUP:GREEN,MEDIA:ORANGE,TOOLS:PURPLE};
  const color = palette[category] || ACCENT;
  const labels = {
    GENERAL:'Commandes générales et état du bot',
    GROUP:'Administration et gestion de groupe',
    MEDIA:'Médias, téléchargements et conversions',
    TOOLS:'Messages, inspection et utilitaires'
  };
  const rows = commandLines(commands);
  let y = 440;
  const rowsSvg = rows.map((pair,i)=>{
    const left = pair[0] ? '.'+pair[0] : '';
    const right = pair[1] ? '.'+pair[1] : '';
    const out = `
      <g transform="translate(74 ${y})">
        <rect width="932" height="92" rx="24" fill="${i%2===0?'#0b1220':'#09101d'}" stroke="#172238"/>
        <text x="34" y="57" fill="#ffffff" font-size="25" font-weight="650">${esc(left)}</text>
        <text x="490" y="57" fill="#ffffff" font-size="25" font-weight="650">${esc(right)}</text>
      </g>`;
    y += 106;
    return out;
  }).join('');
  const h = Math.max(1080, y + 135);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${h}">
    <defs>
      <linearGradient id="bg2" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#03050a"/><stop offset="1" stop-color="#07111e"/>
      </linearGradient>
    </defs>
    <rect width="1080" height="${h}" fill="url(#bg2)"/>
    <rect x="34" y="34" width="1012" height="${h-68}" rx="48" fill="none" stroke="${color}" stroke-opacity=".23" stroke-width="2"/>
    <g transform="translate(74 78)">
      <text x="0" y="42" fill="${color}" font-size="27" font-weight="800" letter-spacing="7">NEXAI // ${category}</text>
      <text x="0" y="122" fill="#ffffff" font-size="56" font-weight="900">${esc(labels[category] || category)}</text>
      <text x="0" y="175" fill="#7489a4" font-size="23">${esc(shortUser(sender))} • ${esc(String(status).toUpperCase())}</text>
      <rect x="0" y="218" width="932" height="92" rx="24" fill="${color}" fill-opacity=".08" stroke="${color}" stroke-opacity=".45"/>
      <text x="32" y="273" fill="${color}" font-size="23" font-weight="700">${commands.length} COMMANDES DISPONIBLES</text>
    </g>
    ${rowsSvg}
    <text x="74" y="${h-60}" fill="#52657e" font-size="18">Use .commande • Bouton ACCUEIL pour revenir au dashboard</text>
  </svg>`;
}

function run(command,args,timeout=20000) {
  return new Promise((resolve,reject)=>{
    const p = spawn(command,args,{stdio:['ignore','pipe','pipe']});
    const err = [];
    const timer=setTimeout(()=>{try{p.kill('SIGKILL')}catch{};reject(new Error('render timeout'))},timeout);
    p.stderr.on('data',d=>err.push(Buffer.from(d)));
    p.on('error',reject);
    p.on('close',code=>{
      clearTimeout(timer);
      if(code) reject(new Error(Buffer.concat(err).toString().slice(-800)||'render failed'));
      else resolve();
    });
  });
}

async function renderSvg(svg,dataDir='/tmp') {
  const parent = path.join(dataDir || '/tmp','tmp');
  await fsp.mkdir(parent,{recursive:true});
  const dir = await fsp.mkdtemp(path.join(parent,'nexui-'));
  const sp=path.join(dir,'card.svg');
  const pp=path.join(dir,'card.png');
  try {
    await fsp.writeFile(sp,svg,'utf8');
    await run('/usr/bin/ffmpeg',['-y','-loglevel','error','-i',sp,'-frames:v','1',pp],25000);
    return await fsp.readFile(pp);
  } finally {
    await fsp.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}

async function sendInteractive(sock,jid,{image,body,buttons,contextInfo={}}) {
  const timeout=(promise,ms,label)=>Promise.race([
    Promise.resolve(promise),
    new Promise((_,reject)=>setTimeout(()=>reject(new Error(label+' timeout')),ms))
  ]);
  const media = await timeout(prepareWAMessageMedia({image},{upload:sock.waUploadToServer}),12000,'media upload');
  const nativeButtons = buttons.map(b=>({
    name:'quick_reply',
    buttonParamsJson:JSON.stringify({display_text:b.label,id:b.id})
  }));
  const content = proto.Message.InteractiveMessage.create({
    contextInfo,
    body:proto.Message.InteractiveMessage.Body.create({text:body}),
    footer:proto.Message.InteractiveMessage.Footer.create({text:'NexAI • Nextech'}),
    header:proto.Message.InteractiveMessage.Header.create({
      title:'',
      subtitle:'',
      hasMediaAttachment:true,
      ...media
    }),
    nativeFlowMessage:proto.Message.InteractiveMessage.NativeFlowMessage.create({buttons:nativeButtons})
  });
  const out=generateWAMessageFromContent(jid,{
    viewOnceMessage:{
      message:{
        messageContextInfo:{deviceListMetadata:{},deviceListMetadataVersion:2},
        interactiveMessage:content
      }
    }
  },{userJid:sock.user?.id});
  await timeout(sock.relayMessage(jid,out.message,{messageId:out.key.id}),12000,'interactive relay');
  return out;
}

export function nexUiActionToCommand(message={}) {
  try {
    let m=message;
    for(let i=0;i<5;i++){
      if(m?.ephemeralMessage?.message)m=m.ephemeralMessage.message;
      else if(m?.viewOnceMessage?.message)m=m.viewOnceMessage.message;
      else if(m?.viewOnceMessageV2?.message)m=m.viewOnceMessageV2.message;
      else break;
    }
    const direct =
      m?.buttonsResponseMessage?.selectedButtonId ||
      m?.templateButtonReplyMessage?.selectedId ||
      m?.listResponseMessage?.singleSelectReply?.selectedRowId;
    if(direct){
      if(String(direct).startsWith('nexui:')) return actionId(String(direct));
      if(String(direct).startsWith('cmd:')) return '.'+String(direct).slice(4);
    }
    const raw=m?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
    if(!raw)return '';
    const data=JSON.parse(raw);
    const id=String(data?.id||data?.selectedId||data?.buttonId||'');
    if(id.startsWith('nexui:'))return actionId(id);
    if(id.startsWith('cmd:'))return '.'+id.slice(4);
  } catch {}
  return '';
}

function actionId(id) {
  const parts=String(id).split(':');
  if(parts[1]==='home')return '.menu';
  if(parts[1]==='category'&&parts[2])return '.nexui '+parts[2].toLowerCase();
  return '.menu';
}

export async function sendNexUi(sock,{
  jid,
  sender,
  rank='USER',
  status='unknown',
  commandCount=50,
  categories={},
  category='',
  dataDir='/tmp',
  contextInfo={}
}={}) {
  const selected=safeCategory(category);
  const image=selected
    ? await renderSvg(categorySvg({category:selected,commands:categories[selected]||[],sender,status}),dataDir)
    : await renderSvg(dashboardSvg({sender,rank,status,commandCount,categories}),dataDir);

  const classicCaption=selected
    ? 'NexAI • '+selected+'\n\n'+(categories[selected]||[]).map(x=>'.'+x).join(' · ')+'\n\n.menu pour revenir à l’accueil'
    : 'NexAI Control Deck\n'+commandCount+' commandes • '+String(status).toUpperCase()+'\n\n.menu general • .menu group • .menu media • .menu tools';
  return sock.sendMessage(jid,{image,caption:classicCaption,contextInfo});

  const buttons = selected
    ? [
        {label:'⌂ ACCUEIL',id:'nexui:home'},
        {label:'GENERAL',id:'nexui:category:GENERAL'},
        {label:'GROUP',id:'nexui:category:GROUP'},
        {label:'MEDIA',id:'nexui:category:MEDIA'}
      ]
    : [
        {label:'GENERAL',id:'nexui:category:GENERAL'},
        {label:'GROUP',id:'nexui:category:GROUP'},
        {label:'MEDIA',id:'nexui:category:MEDIA'},
        {label:'TOOLS',id:'nexui:category:TOOLS'}
      ];

  const body=selected
    ? `${selected} • ${categories[selected]?.length||0} commandes\nChoisis une section ou écris directement .commande`
    : `NexAI Control Deck • ${commandCount} commandes\nChoisis une catégorie.`;

  try {
    return await sendInteractive(sock,jid,{image,body,buttons,contextInfo});
  } catch (error) {
    console.warn('[NexAI Rich UI fallback]',String(error?.message||error).slice(0,500));
    const caption=selected
      ? `NexAI • ${selected}\n\n${(categories[selected]||[]).map(x=>'.'+x).join(' · ')}`
      : `NexAI Control Deck\n${commandCount} commandes • ${String(status).toUpperCase()}`;
    return sock.sendMessage(jid,{image,caption,contextInfo});
  }
}
