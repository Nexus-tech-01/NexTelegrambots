import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createCanvas } from '@napi-rs/canvas';
import { renderTgsToAnimatedWebp } from './lottie-renderer.mjs';

const FFMPEG=String(process.env.FFMPEG_PATH||'ffmpeg');

const tmp=ext=>path.join(
  os.tmpdir(),
  'nexai-sticker-transform-'+process.pid+'-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.'+ext
);
const cleanup=(...files)=>{for(const f of files.flat().filter(Boolean))try{fs.unlinkSync(f)}catch{}};

function exec(cmd,args,timeout=120000){
  return new Promise((resolve,reject)=>{
    execFile(cmd,args,{timeout,maxBuffer:8*1024*1024},(err,stdout,stderr)=>{
      if(err)return reject(new Error(String(stderr||err.message||err).trim().slice(0,1200)));
      resolve({stdout,stderr});
    });
  });
}

function mimeExt(mime=''){
  const m=String(mime).toLowerCase();
  if(m.includes('webm'))return 'webm';
  if(m.includes('webp'))return 'webp';
  if(m.includes('png'))return 'png';
  if(m.includes('jpeg')||m.includes('jpg'))return 'jpg';
  if(m.includes('gif'))return 'gif';
  if(m.includes('mp4'))return 'mp4';
  return 'bin';
}

function clamp(v,min,max){
  return Math.max(min,Math.min(max,Number(v)||0));
}

function normalizeColor(input='#FFFFFF'){
  const named={
    white:'#FFFFFF',black:'#000000',red:'#FF3B30',blue:'#0A84FF',
    green:'#30D158',yellow:'#FFD60A',purple:'#BF5AF2',pink:'#FF375F',
    orange:'#FF9F0A',cyan:'#64D2FF'
  };
  let value=String(input||'').trim().toLowerCase();
  value=named[value]||value;
  if(/^#[0-9a-f]{3}$/i.test(value)){
    value='#'+value.slice(1).split('').map(x=>x+x).join('');
  }
  if(!/^#[0-9a-f]{6}$/i.test(value))return '#FFFFFF';
  return value.toUpperCase();
}

function fitFontSize(ctx,text,maxWidth,max=44,min=18){
  let size=max;
  while(size>min){
    ctx.font='700 '+size+'px sans-serif';
    if(ctx.measureText(text).width<=maxWidth)break;
    size-=2;
  }
  return size;
}

function watermarkOverlayPng(text,{color='#FFFFFF',opacity=0.18,position='bottom'}={}){
  const canvas=createCanvas(512,512);
  const ctx=canvas.getContext('2d');
  const label=String(text||'NexAi').trim().slice(0,80)||'NexAi';
  const alpha=clamp(opacity,0.03,0.85);
  const fill=normalizeColor(color);
  ctx.clearRect(0,0,512,512);
  ctx.fillStyle=fill;
  ctx.globalAlpha=alpha;
  ctx.textAlign='center';
  ctx.textBaseline='middle';

  if(String(position).toLowerCase()==='diagonal'){
    const size=fitFontSize(ctx,label,410,42,18);
    ctx.font='700 '+size+'px sans-serif';
    ctx.save();
    ctx.translate(256,256);
    ctx.rotate(-Math.PI/7);
    ctx.fillText(label,0,0);
    ctx.restore();
  }else{
    const pos=String(position).toLowerCase();
    const y=pos==='top'?58:pos==='center'?256:454;
    const size=fitFontSize(ctx,label,430,pos==='center'?44:34,16);
    ctx.font='700 '+size+'px sans-serif';
    ctx.lineWidth=Math.max(1,Math.round(size/16));
    ctx.strokeStyle='#000000';
    ctx.globalAlpha=alpha*0.42;
    ctx.strokeText(label,256,y);
    ctx.globalAlpha=alpha;
    ctx.fillText(label,256,y);
  }
  return canvas.toBuffer('image/png');
}

function circleMaskPng(){
  const canvas=createCanvas(512,512);
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#000000';
  ctx.fillRect(0,0,512,512);
  ctx.beginPath();
  ctx.arc(256,256,250,0,Math.PI*2);
  ctx.fillStyle='#FFFFFF';
  ctx.fill();
  return canvas.toBuffer('image/png');
}

function zoneRect(zone='bottom'){
  const key=String(zone||'bottom').trim().toLowerCase();
  const presets={
    bottom:[52,394,408,92],
    top:[52,26,408,92],
    center:[76,205,360,102],
    'bottom-left':[20,384,260,100],
    'bottom-right':[232,384,260,100],
    'top-left':[20,28,260,100],
    'top-right':[232,28,260,100]
  };
  if(presets[key])return presets[key];
  const m=key.match(/^(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})$/);
  if(m){
    const x=clamp(m[1],0,500),y=clamp(m[2],0,500);
    const w=clamp(m[3],8,512-x),h=clamp(m[4],8,512-y);
    return [Math.round(x),Math.round(y),Math.round(w),Math.round(h)];
  }
  return presets.bottom;
}

async function sourceInput(source){
  const mime=String(source?.mime||'').toLowerCase();
  if(mime.includes('tgsticker')||mime.includes('x-tgsticker')){
    const animated=await renderTgsToAnimatedWebp(Buffer.from(source.buffer),{
      size:512,targetFps:24,maxSeconds:3
    });
    const file=tmp('webp');
    fs.writeFileSync(file,animated);
    return {file,animated:true,cleanup:[file]};
  }
  const animated=mime.includes('webm')||mime.startsWith('video/')||mime.includes('gif');
  const file=tmp(mimeExt(mime));
  fs.writeFileSync(file,Buffer.from(source.buffer));
  return {file,animated,cleanup:[file]};
}

async function encodeStatic(filterInputs,filterComplex,mapLabel='[out]'){
  const output=tmp('webp');
  try{
    for(const quality of [78,64,50,38,28]){
      await exec(FFMPEG,[
        '-hide_banner','-loglevel','error','-y',
        ...filterInputs,
        '-filter_complex',filterComplex,
        '-map',mapLabel,
        '-frames:v','1',
        '-c:v','libwebp','-lossless','0','-compression_level','6','-q:v',String(quality),
        output
      ]);
      const b=fs.readFileSync(output);
      if(b.length<=512*1024){
        return {buffer:b,format:'static',filename:'sticker.webp',mime:'image/webp'};
      }
    }
    throw new Error('Sticker transformé > 512 Ko.');
  }finally{cleanup(output)}
}

async function encodeVideo(filterInputs,filterComplex,mapLabel='[out]'){
  const output=tmp('webm');
  try{
    for(const crf of [38,42,46,50]){
      await exec(FFMPEG,[
        '-hide_banner','-loglevel','error','-y',
        ...filterInputs,
        '-filter_complex',filterComplex,
        '-map',mapLabel,
        '-t','3',
        '-an','-c:v','libvpx-vp9','-b:v','0','-crf',String(crf),
        '-pix_fmt','yuva420p','-deadline','good','-cpu-used','4',
        output
      ]);
      const b=fs.readFileSync(output);
      if(b.length<=1024*1024){
        return {buffer:b,format:'video',filename:'sticker.webm',mime:'video/webm'};
      }
    }
    throw new Error('Sticker vidéo transformé > 1 Mo.');
  }finally{cleanup(output)}
}

async function transformWithOverlay(source,overlayBuffer){
  const src=await sourceInput(source);
  const overlay=tmp('png');
  fs.writeFileSync(overlay,overlayBuffer);
  try{
    const base="[0:v]fps=30,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba[base];[base][1:v]overlay=0:0:format=auto,format=rgba[out]";
    if(src.animated){
      return await encodeVideo(['-i',src.file,'-loop','1','-i',overlay],base);
    }
    return await encodeStatic(['-i',src.file,'-i',overlay],base);
  }finally{cleanup(overlay,...src.cleanup)}
}

export async function addStickerWatermark(source,{
  text='NexAi',color='#FFFFFF',opacity=0.18,position='bottom'
}={}){
  const overlay=watermarkOverlayPng(text,{color,opacity,position});
  return transformWithOverlay(source,overlay);
}

export async function roundSticker(source){
  const src=await sourceInput(source);
  const mask=tmp('png');
  fs.writeFileSync(mask,circleMaskPng());
  try{
    const filter=[
      "[0:v]fps=30,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba,split=2[base][a0]",
      "[a0]alphaextract[srca]",
      "[1:v]format=gray[mask]",
      "[srca][mask]blend=all_mode=multiply[alpha]",
      "[base][alpha]alphamerge,format=rgba[out]"
    ].join(';');
    if(src.animated){
      return await encodeVideo(['-i',src.file,'-loop','1','-i',mask],filter);
    }
    return await encodeStatic(['-i',src.file,'-i',mask],filter);
  }finally{cleanup(mask,...src.cleanup)}
}

export async function removeStickerWatermark(source,{zone='bottom'}={}){
  const src=await sourceInput(source);
  const [x,y,w,h]=zoneRect(zone);
  try{
    const filter="[0:v]fps=30,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba,delogo=x="+x+":y="+y+":w="+w+":h="+h+":show=0,format=rgba[out]";
    if(src.animated){
      return await encodeVideo(['-i',src.file],filter);
    }
    return await encodeStatic(['-i',src.file],filter);
  }finally{cleanup(...src.cleanup)}
}

export function stickerTransformZone(value='bottom'){
  const [x,y,w,h]=zoneRect(value);
  return {x,y,w,h};
}
