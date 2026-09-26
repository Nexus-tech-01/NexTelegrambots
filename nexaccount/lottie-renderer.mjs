import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec=promisify(execFile);
const FFMPEG=process.env.FFMPEG_PATH||'ffmpeg';
const MAX_TGS_BYTES=Math.max(64*1024,Number(process.env.NEXAI_TGS_MAX_BYTES||2*1024*1024));

function finite(value,fallback){
  const n=Number(value);
  return Number.isFinite(n)?n:fallback;
}

export function decodeTgs(buffer){
  const input=Buffer.from(buffer||[]);
  if(!input.length)throw new Error('TGS vide');
  if(input.length>MAX_TGS_BYTES)throw new Error('TGS trop volumineux');
  if(input[0]!==0x1f||input[1]!==0x8b)throw new Error('TGS invalide : gzip attendu');
  let json;
  try{json=gunzipSync(input).toString('utf8')}catch{throw new Error('TGS invalide : décompression impossible')}
  let data;
  try{data=JSON.parse(json)}catch{throw new Error('TGS invalide : JSON Lottie illisible')}
  const width=Math.max(1,Math.min(2048,Math.round(finite(data.w,512))));
  const height=Math.max(1,Math.min(2048,Math.round(finite(data.h,512))));
  const fps=Math.max(1,Math.min(120,finite(data.fr,30)));
  const ip=finite(data.ip,0);
  const op=Math.max(ip+1,finite(data.op,ip+fps));
  return {json:JSON.stringify(data),data,width,height,fps,ip,op,duration:(op-ip)/fps};
}

async function waitLoaded(player,timeoutMs=12000){
  await new Promise((resolve,reject)=>{
    let timer;
    const done=fn=>value=>{
      clearTimeout(timer);
      try{player.removeEventListener?.('load',onLoad)}catch{}
      try{player.removeEventListener?.('loadError',onError)}catch{}
      fn(value);
    };
    const onLoad=done(resolve);
    const onError=done(event=>reject(new Error('Lottie loadError: '+String(event?.error||event?.message||'unknown'))));
    player.addEventListener('load',onLoad);
    player.addEventListener('loadError',onError);
    timer=setTimeout(()=>onError(new Error('timeout')),timeoutMs);
  });
}

async function encodeAnimatedWebp(frameDir,fps,output){
  const pattern=path.join(frameDir,'frame-%03d.png');
  const attempts=[
    {fps,quality:58},
    {fps,quality:48},
    {fps:Math.min(fps,12),quality:42},
    {fps:Math.min(fps,10),quality:34},
    {fps:Math.min(fps,8),quality:28}
  ];
  let lastError;
  for(const a of attempts){
    try{
      await exec(FFMPEG,[
        '-hide_banner','-loglevel','error','-y',
        '-framerate',String(a.fps),'-i',pattern,
        '-an','-loop','0','-c:v','libwebp_anim',
        '-lossless','0','-compression_level','6','-q:v',String(a.quality),
        output
      ],{maxBuffer:4*1024*1024});
      const stat=await fs.stat(output);
      if(stat.size>0&&stat.size<=500*1024)return fs.readFile(output);
      lastError=new Error('WebP animé > 500 Ko');
    }catch(error){lastError=error}
  }
  throw lastError||new Error('conversion TGS -> WebP impossible');
}

export async function renderTgsToAnimatedWebp(buffer,{size=512,targetFps=15,maxSeconds=6}={}){
  const decoded=decodeTgs(buffer);
  const { DotLottie }=await import('@lottiefiles/dotlottie-web');
  const { createCanvas }=await import('@napi-rs/canvas');

  const side=Math.max(64,Math.min(512,Math.round(Number(size)||512)));
  const canvas=createCanvas(side,side);
  const player=new DotLottie({
    canvas,
    data:decoded.json,
    autoplay:false,
    loop:false,
    renderConfig:{autoResize:false,devicePixelRatio:1}
  });

  const dir=path.join(os.tmpdir(),'nexai-tgs-'+process.pid+'-'+Date.now()+'-'+crypto.randomBytes(5).toString('hex'));
  const output=path.join(dir,'sticker.webp');
  await fs.mkdir(dir,{recursive:true});
  try{
    await waitLoaded(player);
    const seconds=Math.max(0.1,Math.min(maxSeconds,decoded.duration||maxSeconds));
    const fps=Math.max(6,Math.min(20,Number(targetFps)||15));
    const frameCount=Math.max(3,Math.min(90,Math.ceil(seconds*fps)));
    const sourceFrames=Math.max(1,decoded.op-decoded.ip);

    for(let i=0;i<frameCount;i++){
      const sourceFrame=Math.min(sourceFrames-1,Math.floor((i/frameCount)*sourceFrames));
      player.setFrame(sourceFrame);
      const png=await canvas.encode('png');
      await fs.writeFile(path.join(dir,'frame-'+String(i).padStart(3,'0')+'.png'),png);
    }
    return await encodeAnimatedWebp(dir,fps,output);
  }finally{
    try{player.destroy()}catch{}
    await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}
