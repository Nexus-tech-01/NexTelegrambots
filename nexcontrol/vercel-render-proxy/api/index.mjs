const TARGET = "https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexcontrol-ui";
const SESSION_COOKIE = "nxc_proxy_session";
const SESSION_MAX_AGE = 8 * 60 * 60;
const DIRECT_SUPABASE_URL = "https://ojbyvjqurlamplmujmyu.supabase.co";
const DIRECT_SUPABASE_KEY = "sb_publishable_EnV_q5ePfEOB1NxN3-gtpA_HdwjtPyu";
// Do not forward every polling request into a quota-blocked Supabase Edge Function.
// Direct PostgREST agent routes remain available while this circuit is open.
let edgeQuotaCircuitUntil = 0;
const EDGE_QUOTA_RETRY_MS = 60_000;

const HOP = new Set([
  "host","content-length","connection","transfer-encoding","keep-alive","upgrade",
  "proxy-connection","te","trailer","accept-encoding","cookie","x-nxc-session","origin","referer"
]);

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const p = part.trim();
    const i = p.indexOf("=");
    if (i > 0 && p.slice(0, i) === name) return p.slice(i + 1);
  }
  return "";
}

function outboundHeaders(req) {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers || {})) {
    const key = String(k).toLowerCase();
    if (HOP.has(key) || v == null) continue;
    if (Array.isArray(v)) for (const x of v) h.append(key, String(x));
    else h.set(key, String(v));
  }
  const session = cookieValue(req.headers?.cookie, SESSION_COOKIE);
  if (session) h.set("x-nxc-session", session);
  h.set("accept-encoding", "identity");
  return h;
}

function outboundBody(req, headers) {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const b = req.body;
  if (b == null) return undefined;
  if (Buffer.isBuffer(b) || typeof b === "string") return b;
  const ct = String(headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(Object.entries(b).map(([k,v]) => [k, String(v ?? "")])).toString();
  }
  if (ct.includes("application/json") || typeof b === "object") {
    headers.set("content-type", "application/json");
    return JSON.stringify(b);
  }
  return String(b);
}

function copyHeader(res, key, value) {
  try { res.setHeader(key, value); } catch {}
}

function sessionCookie(value) {
  return SESSION_COOKIE + "=" + value + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + SESSION_MAX_AGE;
}

function clearSessionCookie() {
  return SESSION_COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

async function directRpc(name, args) {
  const r = await fetch(DIRECT_SUPABASE_URL + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: {
      apikey: DIRECT_SUPABASE_KEY,
      authorization: "Bearer " + DIRECT_SUPABASE_KEY,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(30000)
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || ("HTTP " + r.status) }; }
  if (!r.ok) throw new Error(String(data?.message || data?.error || ("HTTP " + r.status)));
  return data;
}

function directBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch {} }
  return {};
}

function directJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(data));
}

async function handleDirectAgent(req, res, pathname) {
  if (!pathname.startsWith("/api/v1/agent/")) return false;
  if (req.method !== "POST") { directJson(res, 405, { error: "method_not_allowed" }); return true; }
  const slug = String(req.headers["x-nexcontrol-agent"] || "").trim().toLowerCase();
  const key = String(req.headers["x-nexcontrol-agent-key"] || "");
  const q = directBody(req);
  let d;
  if (pathname === "/api/v1/agent/heartbeat") {
    d = await directRpc("nxc_direct_agent_heartbeat", { p_slug: slug, p_key: key, p_body: q });
    if (d?.ok !== true) { directJson(res, d?.error === "unauthorized" ? 401 : 400, { error: d?.error || "agent_error" }); return true; }
    directJson(res, 200, { ok: true, agentId: d.agentId }); return true;
  }
  if (pathname === "/api/v1/agent/jobs/claim") {
    d = await directRpc("nxc_direct_agent_claim", { p_slug: slug, p_key: key, p_limit: Number(q.limit || 3) });
    if (d?.ok !== true) { directJson(res, d?.error === "unauthorized" ? 401 : 400, { error: d?.error || "agent_error" }); return true; }
    directJson(res, 200, { jobs: Array.isArray(d.jobs) ? d.jobs : [] }); return true;
  }
  if (pathname === "/api/v1/agent/jobs/result") {
    d = await directRpc("nxc_direct_agent_result", {
      p_slug: slug,
      p_key: key,
      p_job_id: String(q.jobId || ""),
      p_ok: q.ok === true,
      p_result: q.result && typeof q.result === "object" ? q.result : {},
      p_error: q.error == null ? null : String(q.error)
    });
    if (d?.ok !== true) {
      directJson(res, d?.error === "unauthorized" ? 401 : d?.error === "not_found" ? 404 : 400, { error: d?.error || "agent_error" });
      return true;
    }
    directJson(res, 200, { ok: true }); return true;
  }
  directJson(res, 404, { error: "not_found" }); return true;
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url || "/", "https://nexcontrol.local");
    if (await handleDirectAgent(req, res, u.pathname)) return;
    if (Date.now() < edgeQuotaCircuitUntil) {
      res.setHeader('retry-after', String(Math.ceil((edgeQuotaCircuitUntil - Date.now()) / 1000)));
      directJson(res, 503, {ok:false,error:'nexcontrol_edge_quota_blocked',retryAfterSeconds:60});
      return;
    }
    const hasSession = !!cookieValue(req.headers?.cookie, SESSION_COOKIE);
    const route = (u.pathname === "/" && hasSession ? "/infrastructure" : u.pathname) + u.search;
    const headers = outboundHeaders(req);
    const body = outboundBody(req, headers);

    const target = new URL(TARGET);
    target.searchParams.set("route", route);

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: "manual"
    });

    if (upstream.status === 402) {
      edgeQuotaCircuitUntil = Date.now() + EDGE_QUOTA_RETRY_MS;
      res.setHeader('retry-after', '60');
      directJson(res, 503, {ok:false,error:'nexcontrol_edge_quota_blocked',retryAfterSeconds:60});
      return;
    }
    const raw = Buffer.from(await upstream.arrayBuffer());
    const preview = raw.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
    const isHtml = preview.startsWith("<!doctype html") || preview.startsWith("<html");
    const newSession = upstream.headers.get("x-nxc-session") || "";
    const location = upstream.headers.get("x-nxc-location") || "";

    for (const [k, v] of upstream.headers) {
      const key = k.toLowerCase();
      if ([
        "content-length","content-encoding","transfer-encoding","connection",
        "set-cookie","x-nxc-session","x-nxc-location"
      ].includes(key)) continue;
      if (key === "content-security-policy" && isHtml) continue;
      copyHeader(res, k, v);
    }

    if (newSession) copyHeader(res, "set-cookie", sessionCookie(newSession));
    else if (location === "/login" && hasSession) {
      copyHeader(res, "set-cookie", clearSessionCookie());
    }

    if (location) {
      copyHeader(res, "location", location);
      copyHeader(res, "cache-control", "no-store");
      res.statusCode = req.method === "POST" ? 303 : 302;
      return res.end();
    }

    if (isHtml) {
      copyHeader(res, "content-type", "text/html; charset=utf-8");
      copyHeader(res, "cache-control", "no-store");
      copyHeader(
        res,
        "content-security-policy",
        "default-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline' https:; img-src 'self' https: data: blob:; connect-src 'self' https: wss:; form-action 'self'; base-uri 'none'; frame-ancestors 'self'"
      );
    } else if (!upstream.headers.get("content-type")) {
      copyHeader(res, "content-type", "application/octet-stream");
    }

    res.statusCode = upstream.status;
    res.end(req.method === "HEAD" ? undefined : raw);
  } catch (error) {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok:false, error:"nexcontrol_proxy_failed" }));
  }
}
