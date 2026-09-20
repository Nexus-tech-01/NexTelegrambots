import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { sendTelegramMedia } from './media-send.mjs';

const FFMPEG=String(process.env.FFMPEG_PATH||'ffmpeg');
const MAX_INPUT_BYTES=Number(process.env.NEXAI_AUDIO_MAX_BYTES||35*1024*1024);
const MAX_OUTPUT_BYTES=Number(process.env.NEXAI_AUDIO_MAX_OUTPUT_BYTES||45*1024*1024);
const MAX_QUEUE_TRACKS=Math.max(2,Math.min(12,Number(process.env.NEXAI_AUDIO_QUEUE_TRACKS)||8));
const QUEUE_TTL_MS=Number(process.env.NEXAI_AUDIO_QUEUE_TTL_MS||30*60*1000);
const TIMEOUT_MS=Number(process.env.NEXAI_AUDIO_TIMEOUT_MS||120000);
const queues=new Map();

function tmp(ext='bin'){
  return path.join(os.tmpdir(),'nexai-audio-'+process.pid+'-'+Date.now()+'-'+crypto.randomBytes(5).toString('hex')+'.'+ext);
}
function cleanup(...files){
  for(const file of files.flat().filter(Boolean)){
    try{fs.unlinkSync(file)}catch{}
  }
}
function clamp(n,min,max,dflt){
  n=Number(n);
  return Number.isFinite(n)?Math.min(max,Math.max(min,n)):dflt;
}
function atempoChain(speed){
  let v=clamp(speed,0.25,4,1);
  const parts=[];
  while(v>2){parts.push('atempo=2');v/=2}
  while(v<0.5){parts.push('atempo=0.5');v/=0.5}
  parts.push('atempo='+v.toFixed(5));
  return parts.join(',');
}
function runFfmpeg(args,timeout=TIMEOUT_MS){
  return new Promise((resolve,reject)=>{
    execFile(FFMPEG,['-hide_banner','-loglevel','error','-y',...args],{timeout,maxBuffer:8*1024*1024},(err,stdout,stderr)=>{
      if(err)return reject(new Error(String(stderr||err.message||err).trim().slice(0,900)));
      resolve({stdout,stderr});
    });
  });
}
async function duration(input){
  return new Promise(resolve=>{
    execFile(FFMPEG,['-hide_banner','-i',input,'-f','null','-'],{timeout:20000,maxBuffer:4*1024*1024},(_err,stdout,stderr)=>{
      const text=String(stderr||stdout||'');
      const m=text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(m?Number(m[1])*3600+Number(m[2])*60+Number(m[3]):0);
    });
  });
}

const PRESETS={
  eqclub:'equalizer=f=80:t=q:w=1:g=5,equalizer=f=12000:t=q:w=1:g=3',
  eqbassboost:'bass=g=10:f=90:w=0.6',
  eqvocal:'highpass=f=100,lowpass=f=12000,equalizer=f=3000:t=q:w=1:g=5',
  eqrock:'bass=g=5:f=100,treble=g=4:f=8000,equalizer=f=1000:t=q:w=1:g=-2',
  eqpop:'bass=g=3:f=100,treble=g=3:f=9000,equalizer=f=2500:t=q:w=1:g=2',
  eqelectro:'bass=g=8:f=80,treble=g=5:f=10000',
  eqhiphop:'bass=g=9:f=70,equalizer=f=250:t=q:w=1:g=2,treble=g=2',
  eqcinema:'bass=g=4,treble=g=3,stereotools=mlev=1.15:slev=1.25',
  bassboost:'bass=g=12:f=80:w=0.6,alimiter=limit=0.95',
  superbass:'bass=g=18:f=70:w=0.5,acompressor=threshold=0.1:ratio=4,alimiter=limit=0.92',
  nightcore:'asetrate=48000*1.18,aresample=48000,atempo=1.06',
  slowed:'asetrate=48000*0.88,aresample=48000,atempo=1.02',
  slowedreverb:'asetrate=48000*0.88,aresample=48000,aecho=0.8:0.75:60|120:0.35|0.22',
  flanger:'flanger',
  chorus:'chorus=0.5:0.9:50|60:0.4|0.3:0.25|0.4:2|2.3',
  phaser:'aphaser',
  tremolo:'tremolo=f=5:d=0.6',
  vibrato:'vibrato=f=5:d=0.5',
  distortion:'acrusher=bits=8:mix=0.65',
  overdrive:'acompressor=threshold=0.15:ratio=6,volume=1.7,alimiter=0.9',
  lofi:'aresample=22050,lowpass=f=5500,highpass=f=100,acompressor=threshold=0.2:ratio=3',
  vinyl:'highpass=f=80,lowpass=f=9000,acrusher=bits=12:mix=0.18',
  radio:'highpass=f=300,lowpass=f=3400,acompressor=ratio=4',
  telephone:'highpass=f=400,lowpass=f=3000',
  underwater:'lowpass=f=800,aecho=0.7:0.65:80:0.25',
  '8d':'apulsator=hz=0.12',
  '3d':'stereotools=mlev=0.9:slev=1.5',
  stereo:'stereotools=slev=1.45',
  mono:'pan=mono|c0=0.5*c0+0.5*c1',
  vocalboost:'highpass=f=90,equalizer=f=3000:t=q:w=1:g=6,acompressor=threshold=0.15:ratio=3',
  vocalreduce:'pan=stereo|c0=c0-c1|c1=c1-c0',
  removevocals:'pan=stereo|c0=c0-c1|c1=c1-c0',
  instrumental:'pan=stereo|c0=c0-c1|c1=c1-c0',
  acapella:'pan=mono|c0=0.5*c0+0.5*c1,highpass=f=120,lowpass=f=8000,equalizer=f=2500:t=q:w=1:g=4',
  denoise:'afftdn=nf=-25',
  dehum:'highpass=f=70,bandreject=f=50:w=3,bandreject=f=60:w=3',
  deess:'equalizer=f=6500:t=q:w=2:g=-5',
  compressor:'acompressor=threshold=0.12:ratio=4:attack=20:release=250',
  limiter:'alimiter=limit=0.90',
  gate:'agate=threshold=0.03:ratio=8',
  master:'highpass=f=25,acompressor=threshold=0.12:ratio=3,loudnorm=I=-14:TP=-1.2:LRA=9',
  masterclub:'bass=g=4:f=90,acompressor=threshold=0.1:ratio=4,loudnorm=I=-10:TP=-1:LRA=7',
  masterloud:'acompressor=threshold=0.08:ratio=5,loudnorm=I=-9:TP=-0.8:LRA=6',
  masterclean:'afftdn=nf=-28,highpass=f=35,loudnorm=I=-14:TP=-1.5:LRA=10',
  masterbass:'bass=g=6:f=85,acompressor=threshold=0.1:ratio=4,loudnorm=I=-11:TP=-1:LRA=8',
  mastervocal:'highpass=f=90,equalizer=f=3000:t=q:w=1:g=4,acompressor=threshold=0.12:ratio=3,loudnorm=I=-14:TP=-1.2:LRA=8'
};

function filterFor(name,args=[]){
  const op=String(name).toLowerCase();
  if(PRESETS[op])return PRESETS[op];
  if(op==='bass')return 'bass=g='+clamp(args[0],-20,20,6)+':f=100';
  if(op==='treble')return 'treble=g='+clamp(args[0],-20,20,5)+':f=8000';
  if(op==='mid')return 'equalizer=f=1200:t=q:w=1:g='+clamp(args[0],-20,20,4);
  if(op==='equalizer')return PRESETS[String(args[0]||'').toLowerCase()]||PRESETS.eqclub;
  if(op==='reverb')return 'aecho=0.8:0.75:'+clamp(args[0],20,500,80)+':0.35';
  if(op==='echo')return 'aecho=0.8:0.8:'+clamp(args[0],20,1000,120)+':0.45';
  if(op==='delay'){const ms=clamp(args[0],1,5000,250);return 'adelay='+ms+'|'+ms}
  if(op==='speed')return atempoChain(clamp(args[0],0.25,4,1.25));
  if(op==='tempo')return atempoChain(clamp(args[0],40,240,120)/120);
  if(op==='pitch'||op==='key'){
    const st=clamp(args[0],-12,12,2),factor=Math.pow(2,st/12);
    return 'asetrate=48000*'+factor.toFixed(6)+',aresample=48000,'+atempoChain(1/factor);
  }
  if(op==='pitchup')return filterFor('pitch',[3]);
  if(op==='pitchdown')return filterFor('pitch',[-3]);
  if(op==='fadein')return 'afade=t=in:st=0:d='+clamp(args[0],0.1,30,3);
  if(op==='fadeout')return 'areverse,afade=t=in:st=0:d='+clamp(args[0],0.1,30,3)+',areverse';
  if(op==='normalize')return 'loudnorm=I=-16:TP=-1.5:LRA=11';
  if(op==='volume')return 'volume='+clamp(args[0],0,5,1.5);
  if(op==='boostvolume')return 'volume=2.2,alimiter=0.95';
  if(op==='reverse')return 'areverse';
  if(op==='lowpass')return 'lowpass=f='+clamp(args[0],50,20000,1200);
  if(op==='highpass')return 'highpass=f='+clamp(args[0],20,18000,250);
  if(op==='bandpass')return 'bandpass=f='+clamp(args[0],50,18000,1000)+':w=300';
  if(op==='filterin')return 'highpass=f=700,afade=t=in:d=4';
  if(op==='filterout')return 'lowpass=f=1800,areverse,afade=t=in:d=4,areverse';
  if(op==='builddup')return 'volume=1.15,highpass=f=120,acompressor=threshold=0.12:ratio=3';
  if(op==='drop')return 'bass=g=10:f=80,volume=1.25,alimiter=0.93';
  return null;
}

export const AUDIO_EFFECT_COMMANDS=new Set([
  'bass','treble','mid','equalizer','eqclub','eqbassboost','eqvocal','eqrock','eqpop','eqelectro','eqhiphop','eqcinema',
  'bassboost','superbass','nightcore','slowed','slowedreverb','reverb','echo','delay','flanger','chorus','phaser','tremolo',
  'vibrato','distortion','overdrive','lofi','vinyl','radio','telephone','underwater','8d','3d','stereo','mono','speed','tempo',
  'pitch','pitchup','pitchdown','key','trim','cut','fadein','fadeout','normalize','volume','boostvolume','audiosilence','reverse',
  'loop','removeintro','removeoutro','filterin','filterout','lowpass','highpass','bandpass','drop','builddup','vocalboost',
  'vocalreduce','removevocals','instrumental','acapella','denoise','dehum','deess','compressor','limiter','gate','master',
  'masterclub','masterloud','masterclean','masterbass','mastervocal'
]);

const DJ_COMMANDS=new Set([
  'queueaudio','audioqueue','clearaudioqueue','removequeue','mix','blend','djmix','crossfade','beatmatch','autodj','syncbpm',
  'transition','joinaudio','splitbeat','bpm','keydetect'
]);

export const AUDIO_LAB_COMMANDS=new Set([
  ...AUDIO_EFFECT_COMMANDS,'analyzesound','waveform','spectrogram',...DJ_COMMANDS
]);

function messageKey(event){
  const m=event?.message;
  return String(event?.chatId||m?.chatId||m?.peerId?.channelId||m?.peerId?.chatId||m?.peerId?.userId||'global');
}
function replyId(message){
  return Number(message?.replyTo?.replyToMsgId||message?.replyToMsgId||0);
}
async function sourceMessage(client,peer,event){
  const id=replyId(event?.message);
  if(id){
    const rows=await client.getMessages(peer,{ids:[id]});
    const msg=Array.isArray(rows)?rows[0]:rows;
    if(msg?.media)return msg;
  }
  if(event?.message?.media)return event.message;
  return null;
}
async function downloadInput(client,peer,event){
  const msg=await sourceMessage(client,peer,event);
  if(!msg)throw new Error('Réponds à un audio, une musique ou une vidéo.');
  const buffer=await client.downloadMedia(msg);
  if(!buffer?.length)throw new Error('Le média est vide ou n’est plus téléchargeable.');
  if(buffer.length>MAX_INPUT_BYTES)throw new Error('Fichier trop volumineux ('+Math.ceil(MAX_INPUT_BYTES/1048576)+' Mo max).');
  const mime=String(msg?.document?.mimeType||msg?.media?.document?.mimeType||'');
  const ext=mime.includes('video')?'mp4':mime.includes('ogg')?'ogg':'mp3';
  const file=tmp(ext);
  fs.writeFileSync(file,Buffer.from(buffer));
  return file;
}

async function processAudio(input,operation,args=[]){
  const output=tmp('mp3'),op=String(operation).toLowerCase();
  const ff=['-i',input];
  if(op==='trim'||op==='cut'){
    const start=clamp(args[0],0,86400,0),end=clamp(args[1],start+0.1,86400,start+30);
    ff.push('-ss',String(start),'-t',String(end-start));
  }else if(op==='removeintro'){
    ff.push('-ss',String(clamp(args[0],0,3600,10)));
  }else if(op==='removeoutro'){
    const dur=await duration(input),cut=clamp(args[0],0,dur,10);
    ff.push('-t',String(Math.max(0.1,dur-cut)));
  }else if(op==='loop'){
    const n=Math.round(clamp(args[0],1,10,2));
    ff.unshift('-stream_loop',String(n-1));
  }else if(op==='audiosilence'){
    const st=clamp(args[0],0,86400,0),en=clamp(args[1],st,86400,st+5);
    ff.push('-af',"volume=enable='between(t,"+st+','+en+")':volume=0");
  }else{
    const filter=filterFor(op,args);
    if(!filter)throw new Error('Effet '+operation+' non configuré.');
    ff.push('-af',filter);
  }
  ff.push('-vn','-c:a','libmp3lame','-b:a','192k',output);
  await runFfmpeg(ff);
  const size=fs.statSync(output).size;
  if(size>MAX_OUTPUT_BYTES){cleanup(output);throw new Error('Sortie audio trop volumineuse.')}
  return output;
}
async function waveform(input,kind){
  const output=tmp('png');
  const args=kind==='spectrogram'
    ?['-i',input,'-lavfi','showspectrumpic=s=1280x720:legend=disabled','-frames:v','1',output]
    :['-i',input,'-filter_complex','showwavespic=s=1280x360:colors=white','-frames:v','1',output];
  await runFfmpeg(args);
  return output;
}
function prune(chat){
  const q=queues.get(chat)||[],fresh=[];
  for(const item of q){
    if(Date.now()-item.addedAt<QUEUE_TTL_MS&&fs.existsSync(item.file))fresh.push(item);
    else cleanup(item.file);
  }
  if(fresh.length)queues.set(chat,fresh);else queues.delete(chat);
  return fresh;
}
function clearQueue(chat){
  for(const item of queues.get(chat)||[])cleanup(item.file);
  queues.delete(chat);
}
setInterval(()=>{for(const chat of queues.keys())prune(chat)},5*60*1000).unref?.();

async function enqueue(client,peer,event,chat){
  const file=await downloadInput(client,peer,event);
  const q=prune(chat);
  if(q.length>=MAX_QUEUE_TRACKS){const old=q.shift();cleanup(old?.file)}
  q.push({file,label:path.basename(file),bytes:fs.statSync(file).size,addedAt:Date.now()});
  queues.set(chat,q);
  return q.length;
}
function queueInfo(chat){
  return prune(chat).map((x,i)=>({index:i+1,label:x.label,mb:(x.bytes/1048576).toFixed(2)}));
}
function removeTrack(chat,index){
  const q=prune(chat),i=Math.max(0,Number(index||q.length)-1);
  if(!q[i])return false;
  cleanup(q[i].file);q.splice(i,1);
  if(q.length)queues.set(chat,q);else queues.delete(chat);
  return true;
}
async function mixFiles(inputs,mode='mix',options={}){
  if(inputs.length<2)throw new Error('Ajoute au moins deux pistes avec .queueaudio.');
  const output=tmp('mp3'),ff=[];
  inputs.forEach(file=>ff.push('-i',file));
  if(mode==='join'||mode==='joinaudio'){
    const labels=inputs.map((_,i)=>'['+i+':a]').join('');
    ff.push('-filter_complex',labels+'concat=n='+inputs.length+':v=0:a=1[out]','-map','[out]');
  }else if(['crossfade','blend','transition','djmix','autodj'].includes(mode)){
    const d=clamp(options.fade,0.5,15,5);
    let graph='[0:a][1:a]acrossfade=d='+d+':c1=tri:c2=tri[x1]',last='x1';
    for(let i=2;i<inputs.length;i++){const next='x'+i;graph+=';['+last+']['+i+':a]acrossfade=d='+d+':c1=tri:c2=tri['+next+']';last=next}
    ff.push('-filter_complex',graph,'-map','['+last+']');
  }else if(mode==='beatmatch'||mode==='syncbpm'){
    const bpms=[];for(const file of inputs)bpms.push(await estimateBpm(file));
    const target=bpms[0]||120;
    const chains=inputs.map((_,i)=>'['+i+':a]'+atempoChain(target/(bpms[i]||target))+'[a'+i+']').join(';');
    const labels=inputs.map((_,i)=>'[a'+i+']').join('');
    ff.push('-filter_complex',chains+';'+labels+'amix=inputs='+inputs.length+':duration=longest:normalize=0[out]','-map','[out]');
  }else{
    const labels=inputs.map((_,i)=>'['+i+':a]').join('');
    ff.push('-filter_complex',labels+'amix=inputs='+inputs.length+':duration=longest:dropout_transition=3:normalize=0[out]','-map','[out]');
  }
  ff.push('-vn','-c:a','libmp3lame','-b:a','192k',output);
  await runFfmpeg(ff,150000);
  return output;
}
async function rawPcm(input,rate=8000,seconds=90){
  const out=tmp('s16le');
  try{
    await runFfmpeg(['-i',input,'-t',String(seconds),'-vn','-ac','1','-ar',String(rate),'-f','s16le',out],90000);
    const b=fs.readFileSync(out);
    return new Int16Array(b.buffer,b.byteOffset,Math.floor(b.byteLength/2));
  }finally{cleanup(out)}
}
function estimateBpmFromPcm(pcm,rate){
  const hop=Math.max(32,Math.round(rate*0.01)),env=[];
  for(let i=0;i+hop<=pcm.length;i+=hop){let sum=0;for(let j=0;j<hop;j++)sum+=Math.abs(pcm[i+j]);env.push(sum/hop)}
  if(env.length<400)return 0;
  const onset=new Float64Array(env.length);let mean=0;
  for(let i=1;i<env.length;i++){onset[i]=Math.max(0,env[i]-env[i-1]);mean+=onset[i]}
  mean/=onset.length;
  for(let i=0;i<onset.length;i++)onset[i]=Math.max(0,onset[i]-mean*0.5);
  let bestLag=0,best=-Infinity;
  const hz=1000/(hop*1000/rate),minLag=Math.floor(hz*60/200),maxLag=Math.ceil(hz*60/60);
  for(let lag=minLag;lag<=maxLag;lag++){let score=0;for(let i=lag;i<onset.length;i++)score+=onset[i]*onset[i-lag];if(score>best){best=score;bestLag=lag}}
  if(!bestLag)return 0;
  let bpm=60*hz/bestLag;while(bpm<75)bpm*=2;while(bpm>180)bpm/=2;
  return Math.round(bpm*10)/10;
}
async function estimateBpm(input){return estimateBpmFromPcm(await rawPcm(input,8000,90),8000)}
const NOTE_NAMES=['C','C♯/D♭','D','D♯/E♭','E','F','F♯/G♭','G','G♯/A♭','A','A♯/B♭','B'];
function goertzel(samples,rate,freq,stride=4){
  const w=2*Math.PI*freq/(rate/stride),c=2*Math.cos(w);let s0=0,s1=0,s2=0;
  for(let i=0;i<samples.length;i+=stride){s0=samples[i]+c*s1-s2;s2=s1;s1=s0}
  return s1*s1+s2*s2-c*s1*s2;
}
async function detectKey(input){
  const rate=11025,pcm=await rawPcm(input,rate,35);
  if(pcm.length<rate)return {key:'Inconnue',confidence:0};
  const chroma=Array(12).fill(0);
  for(let pc=0;pc<12;pc++)for(let oct=2;oct<=6;oct++){
    const midi=12*(oct+1)+pc,freq=440*Math.pow(2,(midi-69)/12);
    if(freq<rate/8)chroma[pc]+=goertzel(pcm,rate,freq);
  }
  const total=chroma.reduce((a,b)=>a+b,0)||1;for(let i=0;i<12;i++)chroma[i]/=total;
  let best={score:-1,root:0,minor:false},second=-1;
  for(let root=0;root<12;root++)for(const minor of [false,true]){
    const third=(root+(minor?3:4))%12,fifth=(root+7)%12;
    const score=chroma[root]*1.35+chroma[third]+chroma[fifth]*1.15+chroma[(root+2)%12]*0.15+chroma[(root+9)%12]*0.15;
    if(score>best.score){second=best.score;best={score,root,minor}}else if(score>second)second=score;
  }
  return {key:NOTE_NAMES[best.root]+' '+(best.minor?'mineur':'majeur'),confidence:Math.max(0,Math.min(99,Math.round((best.score-Math.max(0,second))*900+45)))};
}

async function withInput(client,peer,event,fn){
  let input;
  try{input=await downloadInput(client,peer,event);return await fn(input)}
  finally{cleanup(input)}
}

export async function handleAudioLabCommand({runtime,event,name,args,sendText}){
  name=String(name||'').toLowerCase();
  if(!AUDIO_LAB_COMMANDS.has(name))return false;
  const {client,account}=runtime,peer=event.message.peerId,chat=String(account.telegramUserId)+':'+messageKey(event);
  try{
    if(AUDIO_EFFECT_COMMANDS.has(name)){
      return await withInput(client,peer,event,async input=>{
        const output=await processAudio(input,name,args);
        try{
          await sendTelegramMedia(client,peer,fs.readFileSync(output),{fileName:'NexAI-'+name+'.mp3',mimeType:'audio/mpeg',kind:'audio',caption:'NexAI · Audio Lab · '+name});
        }finally{cleanup(output)}
        return true;
      });
    }
    if(name==='analyzesound'){
      return await withInput(client,peer,event,async input=>{
        const seconds=await duration(input),size=fs.statSync(input).size;
        await sendText(client,peer,'Analyse audio\nDurée : '+seconds.toFixed(2)+' s\nTaille : '+(size/1048576).toFixed(2)+' Mo\nMoteur : FFmpeg');
        return true;
      });
    }
    if(name==='waveform'||name==='spectrogram'){
      return await withInput(client,peer,event,async input=>{
        const output=await waveform(input,name);
        try{await sendTelegramMedia(client,peer,fs.readFileSync(output),{fileName:name+'.png',mimeType:'image/png',kind:'image',caption:'NexAI · '+name})}
        finally{cleanup(output)}
        return true;
      });
    }
    if(name==='queueaudio'){
      const n=await enqueue(client,peer,event,chat);
      await sendText(client,peer,'Piste ajoutée à la file DJ ('+n+'/'+MAX_QUEUE_TRACKS+').');return true;
    }
    if(name==='audioqueue'){
      const q=queueInfo(chat);
      await sendText(client,peer,q.length?'File DJ\n\n'+q.map(x=>x.index+'. '+x.label+' · '+x.mb+' Mo').join('\n'):'File DJ vide.');
      return true;
    }
    if(name==='clearaudioqueue'){clearQueue(chat);await sendText(client,peer,'File DJ vidée.');return true}
    if(name==='removequeue'){await sendText(client,peer,removeTrack(chat,args[0])?'Piste retirée.':'Index invalide.');return true}
    if(['mix','blend','djmix','crossfade','beatmatch','autodj','syncbpm','transition','joinaudio'].includes(name)){
      const q=prune(chat);
      const mode=name==='joinaudio'?'join':name;
      const output=await mixFiles(q.map(x=>x.file),mode,{fade:args[0]});
      try{await sendTelegramMedia(client,peer,fs.readFileSync(output),{fileName:'NexAI-'+name+'.mp3',mimeType:'audio/mpeg',kind:'audio',caption:'NexAI · DJ · '+name})}
      finally{cleanup(output)}
      return true;
    }
    if(name==='bpm'||name==='keydetect'||name==='splitbeat'){
      const q=prune(chat);let input,owned=false;
      if(q.length){input=q[Math.max(0,Number(args[0]||1)-1)]?.file}
      if(!input){input=await downloadInput(client,peer,event);owned=true}
      try{
        if(name==='bpm'){const bpm=await estimateBpm(input);await sendText(client,peer,'BPM détecté : '+(bpm||'indétectable'));return true}
        if(name==='keydetect'){const k=await detectKey(input);await sendText(client,peer,'Tonalité : '+k.key+'\nConfiance : '+k.confidence+'%');return true}
        const bpm=await estimateBpm(input),seconds=await duration(input),beat=bpm?60/bpm:0;
        await sendText(client,peer,'Beat grid\nBPM : '+(bpm||'indétectable')+'\nDurée : '+seconds.toFixed(2)+' s\nIntervalle beat : '+(beat?beat.toFixed(3)+' s':'N/A'));return true;
      }finally{if(owned)cleanup(input)}
    }
  }catch(error){
    await sendText(client,peer,'Audio Lab · '+name+' : '+String(error?.message||error).slice(0,900));
    return true;
  }
  return false;
}
