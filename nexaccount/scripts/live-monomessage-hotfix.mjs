import fs from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';

const base='/opt/nex/apps/public/nexai/current';
const p=base+'/inline-bot.mjs';
const sourceUrl='https://raw.githubusercontent.com/Nexus-tech-01/NexTelegrambots/918fd0932c5b5a521bde9854d3a445555b60055e/nexaccount/inline-bot.mjs';

const response=await fetch(sourceUrl,{signal:AbortSignal.timeout(30000)});
if(!response.ok)throw new Error('source_http_'+response.status);
const src=await response.text();
let live=fs.readFileSync(p,'utf8');

function section(text,start,end){
  const a=text.indexOf(start);
  if(a<0)throw new Error('section_start_missing:'+start);
  const b=text.indexOf(end,a);
  if(b<0)throw new Error('section_end_missing:'+end);
  return text.slice(a,b);
}
function replaceSection(start,end,label){
  const s=section(src,start,end);
  const l=section(live,start,end);
  live=live.replace(l,s);
  if(!live.includes(start))throw new Error('replace_failed:'+label);
}

const helperStart='const monoUiCache=new Map();';
const helperEnd='function nexAiReplyArtworkInput(){';
if(live.includes(helperStart)){
  const l=section(live,helperStart,helperEnd);
  const s=section(src,helperStart,helperEnd);
  live=live.replace(l,s);
}else{
  const s=section(src,helperStart,helperEnd);
  const at=live.indexOf(helperEnd);
  if(at<0)throw new Error('helper_insert_marker_missing');
  live=live.slice(0,at)+s+live.slice(at);
}

replaceSection('async function sendConnectTutorial(ctx,lang){','async function sendPairLink(ctx,lang){','tutorial');
replaceSection('async function sendPairLink(ctx,lang){','function stampMarkup(markup,accountId){','pair');
replaceSection('async function sendModelMessage(ctx,model,accountId){','async function sendDirectMenu(ctx,account,query=\'menu\'){','menu_send');
replaceSection('async function sendBareLanguage(ctx,arg=\'\'){','async function handleBareDirectCommand(ctx,text){','bare_language');
replaceSection('async function sendStart(ctx){','async function sendCreator(ctx){','start');
replaceSection('async function sendCreator(ctx){','async function sendOwner(ctx,kind,args=[]){','creator');
replaceSection('async function sendOwner(ctx,kind,args=[]){','function telegramCommandMenu(){','owner');

const liveMiddleware=section(live,'  bot.use(async(ctx,next)=>{',"  bot.command('start'");
const srcMiddleware=section(src,'  bot.use(async(ctx,next)=>{',"  bot.command('start'");
live=live.replace(liveMiddleware,srcMiddleware);

const oldInvoice="        await sendNexAiPremiumInvoice(ctx.from.id);\n        await ctx.answerCallbackQuery({text:'Facture NexAI Premium envoyée en privé.'});";
const newInvoice="        await removePreviousMonoUi(ctx);\n        const invoice=await sendNexAiPremiumInvoice(ctx.from.id);\n        if(ctx.chat?.type==='private'&&invoice?.message_id){\n          await rememberMonoUi(ctx.chat.id,invoice.message_id);\n        }\n        await ctx.answerCallbackQuery({text:'Facture NexAI Premium envoyée en privé.'});";
if(live.includes(oldInvoice))live=live.replace(oldInvoice,newInvoice);

const callbackStart="  bot.on('callback_query:data',async ctx=>{\n";
if(live.includes(callbackStart)&&!live.includes("  bot.on('callback_query:data',async ctx=>{\n    await adoptCallbackMonoUi(ctx);")){
  live=live.replace(callbackStart,callbackStart+"    await adoptCallbackMonoUi(ctx);\n");
}

fs.mkdirSync(base+'/.runtime',{recursive:true});
const backup=base+'/.runtime/inline-bot.before-monomessage-'+Date.now()+'.mjs';
fs.copyFileSync(p,backup);
const tmp=p+'.tmp-'+Date.now()+'.mjs';
fs.writeFileSync(tmp,live);
const chk=spawnSync(process.execPath,['--check',tmp],{encoding:'utf8'});
if(chk.status!==0){
  try{fs.unlinkSync(tmp)}catch{}
  throw new Error('syntax_failed:'+String(chk.stderr||chk.stdout||'').slice(0,1500));
}
fs.renameSync(tmp,p);

let pid=0;
let env={...process.env};
for(const n of fs.readdirSync('/proc')){
  if(!/^\d+$/.test(n))continue;
  try{
    const cmd=fs.readFileSync('/proc/'+n+'/cmdline','utf8').replace(/\0/g,' ').trim();
    if(cmd.includes('/opt/nex/apps/public/nexai/')&&cmd.endsWith('/daemon.mjs')){
      pid=Number(n);
      env={};
      for(const row of fs.readFileSync('/proc/'+n+'/environ','utf8').split('\0').filter(Boolean)){
        const i=row.indexOf('=');
        if(i>0)env[row.slice(0,i)]=row.slice(i+1);
      }
      break;
    }
  }catch{}
}
if(!pid)throw new Error('live_daemon_not_found');

try{process.kill(pid,'SIGTERM')}catch{}
await new Promise(r=>setTimeout(r,1400));
const child=spawn(process.execPath,[base+'/bootstrap.mjs','--production'],{
  cwd:base,detached:true,stdio:'ignore',env
});
child.unref();

const port=env.NEXACCOUNT_PORT||'18120';
let health=null;
for(let i=0;i<40;i++){
  await new Promise(r=>setTimeout(r,500));
  try{
    const r=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(1500)});
    if(r.ok){health=await r.json();break}
  }catch{}
}
if(!health?.ok)throw new Error('health_not_restored');

const check=fs.readFileSync(p,'utf8');
for(const marker of [
  'const monoUiCache=new Map();',
  'Global monomessage guard for private chats',
  'monoReplyText(ctx',
  'monoReplyPhoto(ctx',
  'monoReplyVideo(ctx',
  'removePreviousMonoUi(ctx)'
]){
  if(!check.includes(marker))throw new Error('marker_missing:'+marker);
}

console.log(JSON.stringify({
  ok:true,
  oldPid:pid,
  worker:health.worker?.id||'',
  botUsername:health.botUsername||'',
  port,
  monomessage:true
}));
