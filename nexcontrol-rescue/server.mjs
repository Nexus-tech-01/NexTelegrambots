// Independent NexControl recovery runtime. Uses the existing Mongo-backed
// NexControl UI and agent/bot protocols, NOT the Supabase Edge proxy.
// It remains isolated until migrated data and agents are explicitly cut over.
import http from "node:http";
import crypto from "node:crypto";
import { db, body, botApi, registerBot, createCampaign, newSession, isAdmin, json, redirect } from "../nexcontrol/lib/core.mjs";
import { agentApi, createAgentJob, getAgentJob } from "../nexcontrol/lib/agent-control.mjs";
import { home, bots, destinations, campaigns, compose } from "../nexcontrol/ui/pages.mjs";
import { serverPage } from "../nexcontrol/ui/server.mjs";
import { loginPage } from "../nexcontrol/ui/layout.mjs";

const PORT = Number(process.env.PORT || 8080);
const REQUIRED = ["MONGODB_URI", "ADMIN_PASSWORD", "SESSION_SECRET", "NEXCONTROL_FLEET_KEY"];
for (const key of REQUIRED) if (!process.env[key] || process.env[key].length < (key === "MONGODB_URI" ? 8 : 20))
  throw new Error("NexControl Rescue: missing or unsafe configuration for " + key);

const tryLogin = new Map();
const answer = (res, code, value) => json(res, code, value);
const html = (res, value, code = 200) => {
  res.writeHead(code, {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"});
  res.end(value);
};
const logSafe = (err) => console.error("[rescue]", String(err?.code || err?.name || "internal_error"));
const passwordMatches = (value) => {
  const a = crypto.createHash("sha256").update(String(value)).digest();
  const b = crypto.createHash("sha256").update(process.env.ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
};
const guardLogin = (req, res) => {
  const ip = String(req.socket.remoteAddress || "unknown");
  const now = Date.now(), state = tryLogin.get(ip);
  if (state && state.until > now && state.fails >= 5) {
    res.setHeader("retry-after", String(Math.ceil((state.until - now) / 1000)));
    answer(res, 429, {error: "too_many_attempts"});
    return false;
  }
  return true;
};
const loginAttempt = (req, success) => {
  const ip = String(req.socket.remoteAddress || "unknown"), now = Date.now();
  if (success) { tryLogin.delete(ip); return; }
  const prev = tryLogin.get(ip);
  tryLogin.set(ip, {fails: (prev && prev.until > now ? prev.fails : 0) + 1, until: now + 15 * 60_000});
  if (tryLogin.size > 10000) for (const [k,v] of tryLogin) if (v.until < now) tryLogin.delete(k);
};
const admin = (req, res) => {
  if (isAdmin(req)) return true;
  answer(res, 401, {error: "unauthorized"});
  return false;
};
const routes = new Map([
  ["/", home], ["/bots", bots], ["/destinations", destinations],
  ["/campaigns", campaigns], ["/campaigns/new", compose], ["/server", serverPage], ["/infrastructure", serverPage]
]);
async function handler(req, res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'");
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;
  if (path === "/health/live" && req.method === "GET") return answer(res, 200, {ok:true,service:"nexcontrol-rescue",version:1});
  if (path === "/health/ready" && req.method === "GET") {
    try { await (await db()).command({ping:1}); return answer(res,200,{ok:true,service:"nexcontrol-rescue",database:"reachable"}); }
    catch { return answer(res,503,{ok:false,service:"nexcontrol-rescue",database:"unavailable"}); }
  }
  // Agent and bot endpoints authenticate using existing server-side keys.
  if (path.startsWith("/api/v1/agent/")) {
    if (req.method !== "POST") return answer(res,405,{error:"method_not_allowed"});
    return agentApi(req,res,path);
  }
  if (path.startsWith("/api/v1/")) {
    if (req.method !== "POST") return answer(res,405,{error:"method_not_allowed"});
    return botApi(req,res,path);
  }
  if (path === "/login" && req.method === "GET") return html(res,loginPage());
  if (path === "/api/admin/login" && req.method === "POST") {
    if (!guardLogin(req,res)) return;
    const input = await body(req);
    const ok = passwordMatches(String(input.password || ""));
    loginAttempt(req,ok);
    if (!ok) return html(res, loginPage(),401);
    const secure = process.env.RESCUE_ALLOW_INSECURE_HTTP === "true" ? "" : "; Secure";
    res.setHeader("set-cookie","nexcontrol_session=" + encodeURIComponent(newSession()) + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800" + secure);
    return redirect(res,"/");
  }
  if (path === "/api/admin/logout" && req.method === "POST") {
    if (!admin(req,res)) return;
    res.setHeader("set-cookie","nexcontrol_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    return redirect(res,"/login");
  }
  if (!isAdmin(req)) return req.method === "GET" && !path.startsWith("/api/")
    ? redirect(res,"/login") : answer(res,401,{error:"unauthorized"});
  if (req.method === "GET" && routes.has(path)) return html(res, await routes.get(path)(url));
  if (path === "/api/admin/bots" && req.method === "POST") return registerBot(req,res);
  if (path === "/api/admin/campaigns" && req.method === "POST") return createCampaign(req,res);
  if (path === "/api/admin/agent/jobs" && req.method === "POST") return createAgentJob(req,res);
  if (path === "/api/admin/agent/jobs" && req.method === "GET") return getAgentJob(req,res,url);
  return answer(res,404,{error:"not_found"});
}
const server = http.createServer(async (req, res) => {
  try { await handler(req,res); } catch(err) {logSafe(err); if (!res.headersSent) answer(res,500,{error:"internal_error"}); else res.end(); }
});
server.requestTimeout=30_000;
server.headersTimeout=15_000;
server.listen(PORT,"0.0.0.0",()=>console.log("[rescue] ready on port",PORT));
process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
