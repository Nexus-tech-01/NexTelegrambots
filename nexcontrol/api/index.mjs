import { body, botApi, createCampaign, env, isAdmin, json, newSession, redirect, registerBot } from '../lib/core.mjs';
import { loginPage } from '../ui/layout.mjs';
import { bots, campaigns, compose, destinations, home } from '../ui/pages.mjs';

export default async function handler(req,res){
  try{
    const url=new URL(req.url,'http://nexcontrol.local'),path=url.pathname;
    if(path==='/api/health')return json(res,200,{ok:true});
    if(path.startsWith('/api/v1/'))return botApi(req,res,path);
    if(path==='/login'&&req.method==='GET')return res.end(loginPage());
    if(path==='/api/admin/login'){
      const q=await body(req);
      if(String(q.password)!==String(env('ADMIN_PASSWORD')))return redirect(res,'/login');
      res.setHeader('set-cookie',`nexcontrol_session=${newSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure`);
      return redirect(res,'/');
    }
    if(!isAdmin(req))return path.startsWith('/api/')?json(res,401,{error:'unauthorized'}):redirect(res,'/login');
    if(path==='/api/admin/logout'){
      res.setHeader('set-cookie','nexcontrol_session=; Path=/; Max-Age=0');
      return redirect(res,'/login');
    }
    if(path==='/api/admin/bots')return registerBot(req,res);
    if(path==='/api/admin/campaigns')return createCampaign(req,res);
    if(path==='/')return res.end(await home());
    if(path==='/bots')return res.end(await bots());
    if(path==='/destinations')return res.end(await destinations(url));
    if(path==='/campaigns')return res.end(await campaigns());
    if(path==='/campaigns/new')return res.end(await compose());
    return json(res,404,{error:'not_found'});
  }catch(error){
    console.error(error);
    return json(res,500,{error:'internal_error'});
  }
}
