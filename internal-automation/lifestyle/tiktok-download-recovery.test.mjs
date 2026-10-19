import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {videoHasDecodableFrame,downloadPlayableTikTok} from './tiktok-download-recovery.mjs';
test('video with valid container but no decoded frames is rejected',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'otaku-'));
  try{
    const file=path.join(dir,'fake.mp4');
    await fs.writeFile(file,Buffer.alloc(5000));
    const result=await videoHasDecodableFrame(file,{run:async()=>({stdout:Buffer.alloc(0)})});
    assert.equal(result,false);
  }finally{await fs.rm(dir,{recursive:true,force:true})}
});
test('tries alternative TikTok format when the first is not decodable',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nexai-'));
 let downloads=0;
 const logger={warn:()=>{}};
 const run=async(cmd,args)=>{
   if(cmd==='yt-dlp'){
     downloads++;
     await fs.writeFile(path.join(dir,'1234567890123.mp4'),Buffer.alloc(5000));
     return {stdout:''};
   }
   if(cmd==='/usr/bin/ffmpeg')return {stdout:downloads===1?Buffer.alloc(0):Buffer.alloc(900)};
   throw new Error('unexpected command');
 };
 try{
   const file=await downloadPlayableTikTok({
     candidate:{item:{id:'1234567890123',url:'https://www.tiktok.com/@a/video/1234567890123'}},
     dir,ytdlp:'yt-dlp',impersonate:'Chrome',run,logger
   });
   assert.equal(downloads,2);
   assert.ok(file.endsWith('.mp4'));
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
