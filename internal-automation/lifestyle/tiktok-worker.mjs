import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {analyzeTikTokVideo} from './tiktok-video-analyzer.mjs';
import {buildStyledCaptions} from './tiktok-caption-style.mjs';

const run=promisify(execFile);
const token=String(process.env.NEXCANAL__BOT_TOKEN||'').trim();
const destination=String(process.env.LIFESTYLE_DESTINATION||'tresor_universe').trim().replace(/^@/,'');
const sourcesFile=process.env.LIFESTYLE_TIKTOK_SOURCES_FILE||'/opt/nex/apps/internal-automation/lifestyle/tiktok-sources.json';
const stateFile=process.env.LIFESTYLE_TIKTOK_STATE_FILE||'/var/lib/nex/state/lifestyle/tiktok-state.json';
const tmpRoot=process.env.LIFESTYLE_TIKTOK_TMP_DIR||'/var/lib/nex/tmp/internal-automation/lifestyle-tiktok';
const ytdlp=process.env.LIFESTYLE_YTDLP||'/opt/nex/bin/yt-dlp';
const waBridge=String(process.env.LIFESTYLE_WHATSAPP_BRIDGE||'http://127.0.0.1:18787/publish').trim();
const dryRun=/^(?:1|true|yes|on)$/i.test(String(process.env.LIFESTYLE_TIKTOK_DRY_RUN||''));
const scanLimit=Math.max(5,Math.min(200,Number(process.env.LIFESTYLE_TIKTOK_SCAN_LIMIT||80)));
const maxSourcesPerRun=Math.max(1,Math.min(6,Number(process.env.LIFESTYLE_TIKTOK_SOURCES_PER_RUN||3)));
const minGapMs=Math.max(30*60_000,Number(process.env.LIFESTYLE_TIKTOK_MIN_GAP_MS||90*60_000));
const maxGapMs=Math.max(minGapMs,Number(process.env.LIFESTYLE_TIKTOK_MAX_GAP_MS||150*60_000));
const impersonate=process.env.LIFESTYLE_TIKTOK_IMPERSONATE||'Chrome-136:Macos-15';

const clean=v=>String(v??'').trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const nextGap=()=>Math.round(minGapMs+Math.random()*(maxGapMs-minGapMs));
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

async function loadState(){
  try{
    const s=JSON.parse(await fs.readFile(stateFile,'utf8'));
    return {
      sourceIndex:Number(s.sourceIndex||0),
      seenIds:Array.isArray(s.seenIds)?s.seenIds.slice(-5000):[],
      failedIds:s.failedIds&&typeof s.failedIds==='object'?s.failedIds:{},
      nextNotBefore:Number(s.nextNotBefore||0),
      lastPublishedAt:s.lastPublishedAt||null,
      lastVideoId:s.lastVideoId||null,
      pendingWhatsApp:Array.isArray(s.pendingWhatsApp)?s.pendingWhatsApp.slice(-50):[]
    };
  }catch{
    return {sourceIndex:0,seenIds:[],failedIds:{},nextNotBefore:0,lastPublishedAt:null,lastVideoId:null,pendingWhatsApp:[]};
  }
}
async function saveState(s){
  await fs.mkdir(path.dirname(stateFile),{recursive:true});
  const tmp=stateFile+'.tmp-'+process.pid;
  await fs.writeFile(tmp,JSON.stringify(s,null,2),{mode:0o600});
  await fs.rename(tmp,stateFile);
}
async function loadSources(){
  const cfg=JSON.parse(await fs.readFile(sourcesFile,'utf8'));
  const out=[];
  for(const [category,rows] of Object.entries(cfg.categories||{})){
    for(const row of Array.isArray(rows)?rows:[]){
      const username=clean(row?.username).replace(/^@/,'');
      if(username&&row?.enabled!==false)out.push({category,username});
    }
  }
  if(!out.length)throw new Error('Aucune source TikTok active');
  return out;
}

async function scanSource(source){
  const url='https://www.tiktok.com/@'+source.username;
  const {stdout}=await run(ytdlp,[
    '--impersonate',impersonate,
    '--flat-playlist','--playlist-end',String(scanLimit),
    '--quiet','--no-warnings','--print-json',url
  ],{timeout:60000,maxBuffer:16*1024*1024});
  const rows=[];
  for(const line of String(stdout).split(/\r?\n/)){
    if(!line.trim())continue;
    try{
      const j=JSON.parse(line);
      const id=clean(j.id);
      if(!/^\d{10,25}$/.test(id))continue;
      rows.push({
        id,
        description:clean(j.title||j.description).slice(0,1500),
        url:'https://www.tiktok.com/@'+source.username+'/video/'+id
      });
    }catch{}
  }
  return rows;
}

async function chooseCandidate(sources,state){
  const seen=new Set(state.seenIds||[]);
  const total=sources.length;
  for(let attempt=0;attempt<Math.min(maxSourcesPerRun,total);attempt++){
    const idx=((state.sourceIndex+attempt)%total+total)%total;
    const source=sources[idx];
    try{
      const items=await scanSource(source);
      const fresh=items.filter(x=>!seen.has(x.id));
      if(fresh.length){
        state.sourceIndex=(idx+1)%total;
        return {source,item:fresh[0]};
      }
    }catch(error){
      console.warn('[Lifestyle/TikTok] scan failed @'+source.username+':',clean(error?.message||error).slice(0,320));
    }
    state.sourceIndex=(idx+1)%total;
  }
  return null;
}

async function downloadVideo(candidate,dir){
  await fs.rm(dir,{recursive:true,force:true});
  await fs.mkdir(dir,{recursive:true});
  const tpl=path.join(dir,candidate.item.id+'.%(ext)s');
  await run(ytdlp,[
    '--impersonate',impersonate,
    '--no-playlist','--no-progress','--restrict-filenames',
    '--merge-output-format','mp4',
    '-o',tpl,
    candidate.item.url
  ],{timeout:150000,maxBuffer:4*1024*1024});
  const names=await fs.readdir(dir);
  const name=names.find(x=>x.startsWith(candidate.item.id+'.')&&!x.endsWith('.part'));
  if(!name)throw new Error('TikTok téléchargé sans fichier final');
  return path.join(dir,name);
}

async function probe(video){
  const {stdout}=await run('/usr/bin/ffprobe',[
    '-v','error','-print_format','json','-show_streams','-show_format',video
  ],{timeout:30000,maxBuffer:2*1024*1024});
  const j=JSON.parse(stdout);
  const vs=(j.streams||[]).find(x=>x.codec_type==='video')||{};
  const as=(j.streams||[]).find(x=>x.codec_type==='audio')||{};
  return {
    duration:Math.max(1,Number(j.format?.duration||vs.duration||10)||10),
    videoCodec:clean(vs.codec_name),
    audioCodec:clean(as.codec_name),
    width:Number(vs.width||0),
    height:Number(vs.height||0),
    bytes:Number(j.format?.size||0)
  };
}

async function normalizeVideo(video,info,dir){
  const inputStat=await fs.stat(video);
  if(info.videoCodec==='h264'&&(!info.audioCodec||info.audioCodec==='aac')&&inputStat.size<45*1024*1024)return video;
  const out=path.join(dir,'normalized.mp4');
  await run('/usr/bin/ffmpeg',[
    '-hide_banner','-loglevel','error','-i',video,
    '-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-crf','23',
    '-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart','-y',out
  ],{timeout:180000,maxBuffer:2*1024*1024});
  let st=await fs.stat(out);
  if(st.size>45*1024*1024){
    const smaller=path.join(dir,'normalized-small.mp4');
    await run('/usr/bin/ffmpeg',[
      '-hide_banner','-loglevel','error','-i',out,
      '-vf','scale=720:-2','-c:v','libx264','-preset','veryfast','-crf','28',
      '-c:a','aac','-b:a','96k','-movflags','+faststart','-y',smaller
    ],{timeout:180000,maxBuffer:2*1024*1024});
    return smaller;
  }
  return out;
}

async function extractFrames(video,duration,dir){
  const frames=[];
  for(const [i,r] of [0.08,0.25,0.45,0.65,0.85].entries()){
    const f=path.join(dir,'frame-'+i+'.jpg');
    await run('/usr/bin/ffmpeg',[
      '-hide_banner','-loglevel','error','-ss',String(Math.max(0,duration*r)),'-i',video,
      '-frames:v','1','-vf','scale=640:-2','-q:v','3','-y',f
    ],{timeout:30000,maxBuffer:1024*1024});
    frames.push(f);
  }
  return frames;
}

async function telegramJson(method,body){
  const r=await fetch('https://api.telegram.org/bot'+token+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
    signal:AbortSignal.timeout(45000)
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.ok)throw new Error(method+': '+clean(j.description||r.status));
  return j.result;
}

async function sendTelegramVideo(video,candidate,captions){
  const bytes=await fs.readFile(video);
  const form=new FormData();
  form.append('chat_id','@'+destination);
  form.append('video',new Blob([bytes],{type:'video/mp4'}),candidate.item.id+'.mp4');
  form.append('caption',captions.html);
  form.append('parse_mode','HTML');
  form.append('supports_streaming','true');
  const r=await fetch('https://api.telegram.org/bot'+token+'/sendVideo',{
    method:'POST',body:form,signal:AbortSignal.timeout(120000)
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.ok)throw new Error('sendVideo: '+clean(j.description||r.status));
  return j.result;
}

async function mirrorWhatsApp(entry){
  const file=await telegramJson('getFile',{file_id:entry.telegramFileId});
  const mediaUrl='https://api.telegram.org/file/bot'+token+'/'+file.file_path;
  const payload={
    id:entry.id,
    source:destination,
    sourceMessageId:entry.telegramMessageId,
    text:entry.text,
    mediaItems:[{
      type:'video',url:mediaUrl,
      fileName:'lifestyle-'+entry.telegramMessageId+'.mp4',
      mimetype:'video/mp4',position:0
    }],
    buttons:[],
    createdAt:entry.createdAt
  };
  const r=await fetch(waBridge,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),
    signal:AbortSignal.timeout(30000)
  });
  const out=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(clean(out?.error||('WhatsApp bridge HTTP '+r.status)));
  return out;
}

async function retryWhatsApp(state){
  const keep=[];
  for(const entry of state.pendingWhatsApp||[]){
    try{
      await mirrorWhatsApp(entry);
      console.log('[Lifestyle/TikTok] WhatsApp retry succeeded Telegram #'+entry.telegramMessageId);
    }catch(error){
      entry.attempts=Number(entry.attempts||0)+1;
      entry.lastError=clean(error?.message||error).slice(0,500);
      if(entry.attempts<20)keep.push(entry);
    }
  }
  state.pendingWhatsApp=keep.slice(-50);
}

function failCandidate(state,id,error){
  const row=state.failedIds[id]||{count:0};
  row.count=Number(row.count||0)+1;
  row.lastError=clean(error?.message||error).slice(0,500);
  row.updatedAt=new Date().toISOString();
  state.failedIds[id]=row;
  if(row.count>=3){
    state.seenIds.push(id);
    state.seenIds=state.seenIds.slice(-5000);
    delete state.failedIds[id];
    console.warn('[Lifestyle/TikTok] quarantined after 3 failures',id);
  }
}

if(!token&&!dryRun)throw new Error('NEXCANAL__BOT_TOKEN missing');
const sources=await loadSources();
const state=await loadState();
await retryWhatsApp(state).catch(error=>console.warn('[Lifestyle/TikTok] WhatsApp retry error:',clean(error?.message||error)));
await saveState(state);

if(!dryRun&&state.nextNotBefore>Date.now()){
  console.log('[Lifestyle/TikTok] next slot at',new Date(state.nextNotBefore).toISOString());
  process.exit(0);
}

const candidate=await chooseCandidate(sources,state);
if(!candidate){
  await saveState(state);
  console.log('[Lifestyle/TikTok] no unseen video in scanned sources');
  process.exit(0);
}

const workDir=path.join(tmpRoot,candidate.item.id);
try{
  const downloaded=await downloadVideo(candidate,workDir);
  const rawInfo=await probe(downloaded);
  const normalized=await normalizeVideo(downloaded,rawInfo,workDir);
  const finalInfo=await probe(normalized);
  const frames=await extractFrames(normalized,finalInfo.duration,workDir);
  const analysis=await analyzeTikTokVideo({
    videoPath:normalized,
    framePaths:frames,
    category:candidate.source.category,
    creator:candidate.source.username,
    description:candidate.item.description,
    duration:finalInfo.duration
  });
  const captions=buildStyledCaptions(candidate,analysis);

  if(dryRun){
    console.log(JSON.stringify({
      ok:true,dryRun:true,
      source:candidate.source,
      videoId:candidate.item.id,
      url:candidate.item.url,
      media:{duration:finalInfo.duration,videoCodec:finalInfo.videoCodec,width:finalInfo.width,height:finalInfo.height},
      analysis,
      caption:captions.plain
    },null,2));
    process.exit(0);
  }

  const sent=await sendTelegramVideo(normalized,candidate,captions);
  const entry={
    id:'lifestyle:tiktok:'+candidate.item.id,
    telegramMessageId:sent.message_id,
    telegramFileId:sent.video?.file_id,
    text:captions.plain,
    createdAt:new Date().toISOString(),
    attempts:0
  };
  if(entry.telegramFileId){
    try{
      await mirrorWhatsApp(entry);
      console.log('[Lifestyle/TikTok] mirrored to WhatsApp');
    }catch(error){
      entry.attempts=1;
      entry.lastError=clean(error?.message||error).slice(0,500);
      state.pendingWhatsApp.push(entry);
      state.pendingWhatsApp=state.pendingWhatsApp.slice(-50);
      console.warn('[Lifestyle/TikTok] WhatsApp mirror queued:',entry.lastError);
    }
  }

  state.seenIds.push(candidate.item.id);
  state.seenIds=state.seenIds.slice(-5000);
  delete state.failedIds[candidate.item.id];
  state.lastVideoId=candidate.item.id;
  state.lastPublishedAt=new Date().toISOString();
  state.nextNotBefore=Date.now()+nextGap();
  await saveState(state);
  console.log('[Lifestyle/TikTok] published',candidate.source.category,'@'+candidate.source.username,candidate.item.id,'-> @'+destination,'#'+sent.message_id);
}catch(error){
  failCandidate(state,candidate.item.id,error);
  await saveState(state);
  console.error('[Lifestyle/TikTok] failed',candidate.item.id,clean(error?.message||error));
  process.exitCode=1;
}finally{
  if(!/^(?:1|true|yes|on)$/i.test(String(process.env.LIFESTYLE_TIKTOK_KEEP_TMP||''))){
    await fs.rm(workDir,{recursive:true,force:true}).catch(()=>{});
  }
}
