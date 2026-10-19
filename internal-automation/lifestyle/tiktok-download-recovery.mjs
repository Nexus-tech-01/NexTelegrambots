import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Check decoded picture data, not just container metadata.
 * A misleading TikTok response can have an H264 stream but no valid frames.
 */
export async function videoHasDecodableFrame(file,{run,ffmpeg='/usr/bin/ffmpeg',minimumSize=4096}={}){
  if(typeof run!=='function')throw new Error('FFmpeg runner requis');
  const st=await fs.stat(file);
  if(st.size<minimumSize)return false;
  for(const seconds of ['0.3','1.5']){
    try{
      const {stdout}=await run(ffmpeg,[
        '-hide_banner','-nostdin','-loglevel','error','-ss',seconds,
        '-i',file,'-frames:v','1','-vf','scale=240:-2',
        '-f','image2pipe','-vcodec','mjpeg','pipe:1'
      ],{encoding:'buffer',timeout:20000,maxBuffer:3*1024*1024});
      if(stdout?.length>220)return true;
    }catch{}
  }
  return false;
}

export async function downloadPlayableTikTok({candidate,dir,ytdlp,impersonate,run,logger=console}){
  if(!candidate?.item?.id||!candidate?.item?.url)throw new Error('URL TikTok manquante');
  const selectors=[
    {format:'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best',impersonate:true},
    {format:'best[ext=mp4]/best',impersonate:false},
    {format:'bv*+ba/b',impersonate:true}
  ];
  let last=null;
  for(const [attempt,selector] of selectors.entries()){
    await fs.rm(dir,{recursive:true,force:true});
    await fs.mkdir(dir,{recursive:true});
    const args=[
      '--no-playlist','--no-progress','--restrict-filenames',
      '--no-part','--no-warnings','--format',selector.format,
      '--merge-output-format','mp4',
      '-o',path.join(dir,candidate.item.id+'.%(ext)s'),
      candidate.item.url
    ];
    if(selector.impersonate)args.unshift('--impersonate',impersonate);
    try{
      await run(ytdlp,args,{timeout:70000,maxBuffer:4*1024*1024});
      const names=(await fs.readdir(dir)).filter(x=>
        x.startsWith(candidate.item.id+'.')&&/\.(mp4|mkv|webm|mov)$/i.test(x)
      );
      for(const name of names){
        const file=path.join(dir,name);
        if(await videoHasDecodableFrame(file,{run}))return file;
      }
      throw new Error('Vidéo téléchargée mais aucune image H.264/vidéo décodable');
    }catch(error){
      last=error;
      logger.warn?.('[Lifestyle/TikTok] invalid video download, alternate format '+(attempt+1)+': '+String(error?.message||error).slice(0,180));
    }
  }
  throw new Error('Aucun flux TikTok vidéo décodable après variantes : '+String(last?.message||last||'échec').slice(0,200));
}
