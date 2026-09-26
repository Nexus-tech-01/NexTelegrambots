import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { body, botApi, createCampaign, env, isAdmin, json, newSession, redirect, registerBot } from '../lib/core.mjs';
import { agentApi, agentControlConfigured, createAgentJob, getAgentJob } from '../lib/agent-control.mjs';
import { nexaiPublicApi } from '../lib/nexai-public.mjs';
import { loginPage } from '../ui/layout.mjs';
import { bots, campaigns, compose, destinations, home } from '../ui/pages.mjs';
import { nexaiConnectPage } from '../ui/nexai.mjs';
import { serverPage } from '../ui/server.mjs';

const passwordMatches=value=>{
  const expected=String(process.env.ADMIN_PASSWORD_HASH||'').trim().toLowerCase();
  if(expected)return crypto.createHash('sha256').update(String(value??'')).digest('hex')===expected;
  return String(value??'')===String(env('ADMIN_PASSWORD'));
};

async function nexaiAsset(res){
  try{
    const bytes=await fs.readFile(new URL('../ui/assets/nexai-hero.webp',import.meta.url));
    res.statusCode=200;
    res.setHeader('content-type','image/webp');
    res.setHeader('cache-control','public, max-age=86400, immutable');
    res.setHeader('x-content-type-options','nosniff');
    return res.end(bytes);
  }catch{
    try{
      const upstream=await fetch('https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexai-hero');
      if(!upstream.ok)throw new Error('hero_upstream_failed');
      const bytes=Buffer.from(await upstream.arrayBuffer());
      res.statusCode=200;
      res.setHeader('content-type','image/webp');
      res.setHeader('cache-control','public, max-age=86400, immutable');
      res.setHeader('x-content-type-options','nosniff');
      return res.end(bytes);
    }catch{
      res.statusCode=404;
      return res.end();
    }
  }
}

async function nexaiMusicAsset(req,res){
  try{
    const file=new URL('../ui/assets/montagem-gloria.ogg',import.meta.url);
    const bytes=await fs.readFile(file);
    const total=bytes.length;
    const range=String(req.headers.range||'');
    res.setHeader('content-type','audio/ogg');
    res.setHeader('accept-ranges','bytes');
    res.setHeader('cache-control','public, max-age=86400, immutable');
    res.setHeader('x-content-type-options','nosniff');
    if(range.startsWith('bytes=')){
      const m=range.match(/^bytes=(\d*)-(\d*)$/);
      if(m){
        let start=m[1]?Number(m[1]):0;
        let end=m[2]?Number(m[2]):total-1;
        if(!m[1]&&m[2]){const suffix=Number(m[2]);start=Math.max(0,total-suffix);end=total-1}
        start=Math.max(0,Math.min(start,total-1));
        end=Math.max(start,Math.min(end,total-1));
        const chunk=bytes.subarray(start,end+1);
        res.statusCode=206;
        res.setHeader('content-range','bytes '+start+'-'+end+'/'+total);
        res.setHeader('content-length',String(chunk.length));
        return res.end(chunk);
      }
    }
    res.statusCode=200;
    res.setHeader('content-length',String(total));
    return res.end(bytes);
  }catch{
    res.statusCode=404;
    return res.end();
  }
}

export default async function handler(req,res){
  try{
    const url=new URL(req.url,'http://nexcontrol.local'),path=url.pathname;
    if(req.method==='GET'&&!path.startsWith('/api/'))res.setHeader('content-type','text/html; charset=utf-8');
    if(path==='/api/health')return json(res,200,{ok:true,agentControl:agentControlConfigured()});
    if(path.startsWith('/api/v1/agent/'))return agentApi(req,res,path);
    if(path.startsWith('/api/v1/'))return botApi(req,res,path);

    if(path==='/nexai/connect'&&req.method==='GET'){
      res.setHeader('cache-control','no-store');
      return res.end(nexaiConnectPage(url));
    }
    if(path==='/nexai/assets/hero.webp'&&req.method==='GET')return nexaiAsset(res);
    if(path==='/nexai/assets/music.ogg'&&req.method==='GET')return nexaiMusicAsset(req,res);
    if(path.startsWith('/api/public/nexai/'))return nexaiPublicApi(req,res,path,url);

    if(path==='/login'&&req.method==='GET')return res.end(loginPage());
    if(path==='/api/admin/login'){
      const q=await body(req);
      if(!passwordMatches(q.password))return redirect(res,'/login');
      res.setHeader('set-cookie',`nexcontrol_session=${newSession()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800; Secure`);
      return redirect(res,'/');
    }
    if(!isAdmin(req))return path.startsWith('/api/')?json(res,401,{error:'unauthorized'}):redirect(res,'/login');
    if(path==='/api/admin/logout'){
      res.setHeader('set-cookie','nexcontrol_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure');
      return redirect(res,'/login');
    }
    if(path==='/api/admin/bots')return registerBot(req,res);
    if(path==='/api/admin/campaigns')return createCampaign(req,res);
    if(path==='/api/admin/agent/jobs'&&req.method==='POST')return createAgentJob(req,res);
    if(path==='/api/admin/agent/jobs'&&req.method==='GET')return getAgentJob(req,res,url);
    if(path==='/')return res.end(await home());
    if(path==='/bots')return res.end(await bots());
    if(path==='/destinations')return res.end(await destinations(url));
    if(path==='/campaigns')return res.end(await campaigns());
    if(path==='/campaigns/new')return res.end(await compose());
    if(path==='/server')return res.end(await serverPage(url));
    return json(res,404,{error:'not_found'});
  }catch(error){
    console.error('[NexControl]',error);
    return json(res,500,{error:'internal_error'});
  }
}
