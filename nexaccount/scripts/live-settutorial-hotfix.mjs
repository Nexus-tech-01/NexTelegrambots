import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const base='/opt/nex/apps/public/nexai/current';
const p=base+'/inline-bot.mjs';
const runtimeDir=base+'/.runtime';
const sourcePath=new URL('../inline-bot.mjs',import.meta.url);
const src=fs.readFileSync(sourcePath,'utf8');
let live=fs.readFileSync(p,'utf8');

const storeLive=fs.readFileSync(base+'/store.mjs','utf8');
const replyLive=fs.readFileSync(base+'/reply-storage.mjs','utf8');
if(!/export\s+(async\s+)?function\s+db/.test(storeLive))throw new Error('live_db_export_missing');
if(!replyLive.includes('export async function storeReplyVideo'))throw new Error('live_storeReplyVideo_missing');
if(!replyLive.includes('export async function resolveReplyStorageChannel'))throw new Error('live_resolveReplyStorageChannel_missing');

function lineContaining(text,needle){
  const row=text.split('\n').find(x=>x.includes(needle));
  if(!row)throw new Error('source_line_missing:'+needle);
  return row;
}
function section(text,start,end){
  const a=text.indexOf(start);
  if(a<0)throw new Error('section_start_missing:'+start);
  const b=text.indexOf(end,a);
  if(b<0)throw new Error('section_end_missing:'+end);
  return text.slice(a,b);
}
function replaceOnce(a,b,label){
  if(!live.includes(a))throw new Error('live_marker_missing:'+label);
  live=live.replace(a,b);
}

replaceOnce(
  lineContaining(live,"from './store.mjs';"),
  lineContaining(src,"from './store.mjs';"),
  'store_import'
);
replaceOnce(
  lineContaining(live,"from './reply-storage.mjs';"),
  lineContaining(src,"from './reply-storage.mjs';"),
  'reply_storage_import'
);

const liveConnect=section(live,'function connectMarkup(lang){','async function sendPairLink(ctx,lang){');
const srcConnect=section(src,"const CONNECT_TUTORIAL_CALLBACK='connect:tutorial';",'async function sendPairLink(ctx,lang){');
replaceOnce(liveConnect,srcConnect,'connect_section');

const pairMarker="  bot.command('pair',async ctx=>{";
const srcCommands=section(src,'  async function handleSetTutorial(ctx){',pairMarker);
replaceOnce(pairMarker,srcCommands+pairMarker,'settutorial_commands');

const liveText="  bot.on('message:text',async ctx=>{\n    if(ctx.chat?.type!=='private')return;\n    const text=String(ctx.message.text||'').trim();\n    if(text.startsWith('/'))return;";
const srcText=section(
  src,
  "  bot.on('message:text',async ctx=>{",
  "    // The presentation bot also accepts native commands without a prefix."
).trimEnd();
replaceOnce(liveText,srcText,'text_fallback');

const liveCb="  bot.on('callback_query:data',async ctx=>{\n    const raw=String(ctx.callbackQuery.data||'');\n    const cut=raw.lastIndexOf('|');\n    console.log('[NexAI callback] received',raw.slice(0,120),'from='+String(ctx.from?.id||''),'inline='+String(!!ctx.callbackQuery.inline_message_id));\n    if(cut<0){await ctx.answerCallbackQuery();return}";
const srcCbPrefix=section(
  src,
  "  bot.on('callback_query:data',async ctx=>{",
  "    const action=raw.slice(0,cut),accountId=raw.slice(cut+1);"
).trimEnd();
replaceOnce(liveCb,srcCbPrefix,'callback_tutorial');

fs.mkdirSync(runtimeDir,{recursive:true});
const backup=runtimeDir+'/inline-bot.before-settutorial-'+Date.now()+'.mjs';
fs.copyFileSync(p,backup);
const tmp=p+'.tmp-'+Date.now();
fs.writeFileSync(tmp,live);

const chk=spawnSync(process.execPath,['--check',tmp],{encoding:'utf8'});
if(chk.status!==0){
  try{fs.unlinkSync(tmp)}catch{}
  throw new Error('syntax_failed:'+String(chk.stderr||chk.stdout||'').slice(0,1200));
}
fs.renameSync(tmp,p);

console.log(JSON.stringify({
  ok:true,
  backup,
  bytes:live.length,
  hasTutorial:live.includes('CONNECT_TUTORIAL_CALLBACK'),
  hasSetTutorial:live.includes("bot.command('settutorial'"),
  hasBare:live.includes('settutorial(?:@[A-Za-z0-9_]+)?'),
  hasCallback:live.includes('raw===CONNECT_TUTORIAL_CALLBACK')
}));
