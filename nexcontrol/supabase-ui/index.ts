const BACKEND = "https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexcontrol";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TABLE = "nxc_web_proxy_sessions";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const ALLOWED_ORIGINS = new Set([
  "https://tresor562.github.io",
  "https://tresor-hontonnou.zone.id",
  "https://www.tresor-hontonnou.zone.id",
]);

function b64u(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromB64u(s: string) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
async function sha256(value: string) {
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))));
}
const aesKeyPromise = (async () => {
  const material = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    enc.encode(SERVICE_ROLE + "|nexcontrol-web-proxy-v1"),
  ));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
})();
async function seal(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKeyPromise;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(value)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0); out.set(ct, iv.length);
  return b64u(out);
}
async function unseal(value: string) {
  const all = fromB64u(value);
  const iv = all.slice(0, 12);
  const ct = all.slice(12);
  const key = await aesKeyPromise;
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return dec.decode(pt);
}

function cors(origin: string | null) {
  const h = new Headers({
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-nxc-session,x-requested-with",
    "access-control-expose-headers": "x-nxc-location,x-nxc-session,x-nxc-route,content-type",
    "access-control-max-age": "86400",
    "vary": "Origin",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (origin && ALLOWED_ORIGINS.has(origin)) h.set("access-control-allow-origin", origin);
  return h;
}
function addCors(target: Headers, origin: string | null) {
  const h = cors(origin);
  for (const [k, v] of h) target.set(k, v);
}

async function rest(path: string, init: RequestInit = {}) {
  const h = new Headers(init.headers || {});
  h.set("apikey", SERVICE_ROLE);
  h.set("authorization", "Bearer " + SERVICE_ROLE);
  if (!h.has("content-type") && init.body) h.set("content-type", "application/json");
  return fetch(SUPABASE_URL + "/rest/v1/" + path, { ...init, headers: h });
}
async function loadSession(rawToken: string, ua: string) {
  if (!rawToken || rawToken.length > 256) return null;
  const tokenHash = await sha256(rawToken);
  const r = await rest(TABLE + "?token_hash=eq." + encodeURIComponent(tokenHash) +
    "&select=token_hash,cookie_ciphertext,user_agent_hash,expires_at&limit=1");
  if (!r.ok) return null;
  const rows = await r.json();
  const row = rows?.[0];
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null;
  const uaHash = await sha256(ua || "");
  if (row.user_agent_hash !== uaHash) return null;
  try {
    return { tokenHash, cookie: await unseal(row.cookie_ciphertext) };
  } catch {
    return null;
  }
}
async function saveSession(rawToken: string, cookie: string, ua: string) {
  const tokenHash = await sha256(rawToken);
  const body = {
    token_hash: tokenHash,
    cookie_ciphertext: await seal(cookie),
    user_agent_hash: await sha256(ua || ""),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    updated_at: new Date().toISOString(),
  };
  const r = await rest(TABLE + "?on_conflict=token_hash", {
    method: "POST",
    headers: { "prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("proxy session save failed: " + r.status);
  return tokenHash;
}
async function deleteSessionByRaw(rawToken: string) {
  if (!rawToken) return;
  const tokenHash = await sha256(rawToken);
  await rest(TABLE + "?token_hash=eq." + encodeURIComponent(tokenHash), { method: "DELETE" });
}
async function cleanupExpired() {
  await rest(TABLE + "?expires_at=lt." + encodeURIComponent(new Date().toISOString()), { method: "DELETE" });
}

function randomToken() {
  return b64u(crypto.getRandomValues(new Uint8Array(32)));
}
function cookieMap(cookieHeader: string) {
  const map = new Map<string, string>();
  for (const part of (cookieHeader || "").split(";")) {
    const p = part.trim();
    const i = p.indexOf("=");
    if (i > 0) map.set(p.slice(0, i), p.slice(i + 1));
  }
  return map;
}
function setCookies(headers: Headers): string[] {
  const fn = (headers as any).getSetCookie;
  if (typeof fn === "function") {
    try { return fn.call(headers) || []; } catch {}
  }
  const one = headers.get("set-cookie");
  return one ? [one] : [];
}
function mergeCookies(current: string, incoming: string[]) {
  const map = cookieMap(current);
  for (const sc of incoming) {
    const first = sc.split(";", 1)[0]?.trim() || "";
    const i = first.indexOf("=");
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1);
    if (!name || name.startsWith("__cf") || name.startsWith("cf_")) continue;
    const low = sc.toLowerCase();
    const remove = value === "" || /max-age\s*=\s*0/.test(low) || /expires\s*=\s*thu,\s*01\s*jan\s*1970/.test(low);
    if (remove) map.delete(name); else map.set(name, value);
  }
  return [...map.entries()].map(([k, v]) => k + "=" + v).join("; ");
}
function safeRoute(raw: string | null) {
  const v = raw || "/";
  if (!v.startsWith("/") || v.startsWith("//") || v.length > 4096 || /[\u0000-\u001f]/.test(v)) return null;
  try {
    const u = new URL(v, "https://nexcontrol.local");
    if (u.origin !== "https://nexcontrol.local") return null;
    if (u.pathname.split("/").some(x => x === "..")) return null;
    return u;
  } catch {
    return null;
  }
}
function upstreamHeaders(req: Request, path: string, cookie: string) {
  const h = new Headers(req.headers);
  for (const k of [
    "host","content-length","connection","transfer-encoding","keep-alive","upgrade",
    "proxy-connection","te","trailer","accept-encoding","origin","referer",
    "authorization","apikey","cookie","x-nxc-session"
  ]) h.delete(k);
  h.set("x-nexcontrol-path", path);
  h.set("accept-encoding", "identity");
  if (cookie) h.set("cookie", cookie);
  return h;
}

Deno.serve(async (req: Request) => {
  const requestUrl = new URL(req.url);
  const origin = req.headers.get("origin");

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return new Response(JSON.stringify({ ok: false, error: "origin_not_allowed" }), {
      status: 403,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(origin) });
  }

  const route = safeRoute(requestUrl.searchParams.get("route"));
  if (!route) {
    const h = cors(origin); h.set("content-type", "application/json");
    return new Response(JSON.stringify({ ok: false, error: "invalid_route" }), { status: 400, headers: h });
  }

  const ua = req.headers.get("user-agent") || "";
  const rawProxyToken = (req.headers.get("x-nxc-session") || "").trim();
  const existing = await loadSession(rawProxyToken, ua);
  let upstreamCookie = existing?.cookie || "";

  const body = (req.method === "GET" || req.method === "HEAD") ? undefined : await req.arrayBuffer();
  const upstream = await fetch(BACKEND + route.search, {
    method: req.method,
    headers: upstreamHeaders(req, route.pathname, upstreamCookie),
    body,
    redirect: "manual",
  });

  const incomingCookies = setCookies(upstream.headers);
  const mergedCookie = mergeCookies(upstreamCookie, incomingCookies);
  let newProxyToken = "";
  const isLogin = route.pathname === "/api/admin/login" && req.method === "POST";
  const location = upstream.headers.get("location") || "";

  if (isLogin && mergedCookie && mergedCookie !== upstreamCookie) {
    newProxyToken = randomToken();
    await saveSession(newProxyToken, mergedCookie, ua);
    cleanupExpired().catch(() => {});
  } else if (existing && mergedCookie && mergedCookie !== upstreamCookie) {
    await saveSession(rawProxyToken, mergedCookie, ua);
  }

  const isLogout = route.pathname === "/api/admin/logout";
  const redirectedToLogin = location === "/login" && !!existing;
  if ((isLogout || redirectedToLogin || upstream.status === 401) && rawProxyToken) {
    await deleteSessionByRaw(rawProxyToken);
  }

  const out = new Headers(upstream.headers);
  for (const k of [
    "set-cookie","content-length","content-encoding","transfer-encoding","connection",
    "location","content-security-policy","x-frame-options"
  ]) out.delete(k);
  addCors(out, origin);
  out.set("x-nxc-route", route.pathname + route.search);
  if (location) out.set("x-nxc-location", location);
  if (newProxyToken) out.set("x-nxc-session", newProxyToken);

  const bytes = new Uint8Array(await upstream.arrayBuffer());

  if (location && upstream.status >= 300 && upstream.status < 400) {
    out.set("content-type", "text/plain; charset=utf-8");
    return new Response(bytes.length ? bytes : null, { status: 200, headers: out });
  }

  return new Response(bytes, { status: upstream.status, headers: out });
});