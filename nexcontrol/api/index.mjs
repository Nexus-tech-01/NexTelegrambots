import { body, botApi, createCampaign, env, isAdmin, json, newSession, redirect, registerBot } from '../lib/core.mjs';
import { agentApi, agentControlConfigured, createAgentJob, getAgentJob } from '../lib/agent-control.mjs';
import { loginPage } from '../ui/layout.mjs';
import { bots, campaigns, compose, destinations, home } from '../ui/pages.mjs';
import { serverPage } from '../ui/server.mjs';

function html(res,status,content){res.statusCode=status;res.setHeader('content-type','text/html; charset=utf-8');return res.end(content)}

export default async function handler(req,res){
  try{
    const url=new URL(req.url,'http://nexcontrol.local'),path=url.pathname;
    if(path==='/api/health')return json(res,200,{ok:true,agentControl:agentControlConfigured()});
    if(path.startsWith('/api/v1/agent/'))return agentApi(req,res,path);
    if(path.startsWith('/api/v1/'))return botApi(req,res,path);
    if(path==='/login'&&req.method==='GET')return html(res,200,loginPage());
    if(path==='/api/admin/login'){
      const q=await body(req);
      if(String(q.password)!==String(env('ADMIN_PASSWORD')))return redirect(res,'/login');
      res.setHeader('set-cookie',`nexcontrol_session=${newSession()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800; Secure`);
      const dashboard=await home();
      const navigationFix=`<script>try{history.replaceState(null,'','/')}catch(e){}</script>`;
      return html(res,200,dashboard.includes('</body>')?dashboard.replace('</body>',`${navigationFix}</body>`):dashboard+navigationFix);
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
    if(path==='/')return html(res,200,await home());
    if(path==='/bots')return html(res,200,await bots());
    if(path==='/destinations')return html(res,200,await destinations(url));
    if(path==='/campaigns')return html(res,200,await campaigns());
    if(path==='/campaigns/new')return html(res,200,await compose());
    if(path==='/server')return html(res,200,await serverPage(url));
    return json(res,404,{error:'not_found'});
  }catch(error){
    console.error('[NexControl]',error);
    return json(res,500,{error:'internal_error'});
  }
}
