const TARGET = "https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexcontrol";

const HOP = new Set([
  "host","content-length","connection","transfer-encoding","keep-alive","upgrade",
  "proxy-connection","te","trailer","accept-encoding"
]);

function outboundHeaders(req, path) {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers || {})) {
    const key = String(k).toLowerCase();
    if (HOP.has(key) || v == null) continue;
    if (Array.isArray(v)) for (const x of v) h.append(key, String(x));
    else h.set(key, String(v));
  }
  h.set("x-nexcontrol-path", path || "/");
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

export default async function handler(req, res) {
  try {
    const u = new URL(req.url || "/", "https://nexcontrol.local");
    const headers = outboundHeaders(req, u.pathname);
    const body = outboundBody(req, headers);

    const upstream = await fetch(TARGET + u.search, {
      method: req.method,
      headers,
      body,
      redirect: "manual"
    });

    const raw = Buffer.from(await upstream.arrayBuffer());
    const preview = raw.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
    const isHtml = preview.startsWith("<!doctype html") || preview.startsWith("<html");

    for (const [k, v] of upstream.headers) {
      const key = k.toLowerCase();
      if (["content-length","content-encoding","transfer-encoding","connection","set-cookie"].includes(key)) continue;
      if (key === "content-security-policy" && isHtml) continue;
      copyHeader(res, k, v);
    }

    const getSetCookie = upstream.headers.getSetCookie;
    if (typeof getSetCookie === "function") {
      const cookies = getSetCookie.call(upstream.headers);
      if (cookies?.length) copyHeader(res, "set-cookie", cookies);
    } else {
      const cookie = upstream.headers.get("set-cookie");
      if (cookie) copyHeader(res, "set-cookie", cookie);
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
