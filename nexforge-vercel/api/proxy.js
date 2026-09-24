const UPSTREAM = "https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nxc-env-keys-probe";

export default async function handler(req, res) {
  try {
    const incoming = new URL(req.url || "/", "https://nexforge.local");
    const upstream = new URL(UPSTREAM);
    for (const [k, v] of incoming.searchParams.entries()) upstream.searchParams.append(k, v);

    const headers = {};
    const pass = ["cookie", "content-type", "accept", "user-agent", "x-forwarded-for", "x-real-ip"];
    for (const name of pass) {
      const value = req.headers[name];
      if (value) headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }

    let body;
    if (!["GET", "HEAD"].includes(req.method || "GET")) {
      if (Buffer.isBuffer(req.body)) body = req.body;
      else if (typeof req.body === "string") body = req.body;
      else if (req.body != null) {
        if ((headers["content-type"] || "").includes("application/json")) body = JSON.stringify(req.body);
        else if ((headers["content-type"] || "").includes("application/x-www-form-urlencoded")) body = new URLSearchParams(req.body).toString();
        else body = JSON.stringify(req.body);
      }
    }

    const r = await fetch(upstream, {
      method: req.method,
      headers,
      body,
      redirect: "manual"
    });

    const raw = Buffer.from(await r.arrayBuffer());
    const textStart = raw.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
    const looksHtml = textStart.startsWith("<!doctype html") || textStart.startsWith("<html");

    const skip = new Set(["content-length", "content-encoding", "transfer-encoding", "connection"]);
    for (const [k, v] of r.headers.entries()) {
      const key = k.toLowerCase();
      if (skip.has(key) || key === "location" || key === "set-cookie" || key === "content-type") continue;
      res.setHeader(k, v);
    }

    const setCookie = r.headers.get("set-cookie");
    if (setCookie) res.setHeader("set-cookie", setCookie);

    const location = r.headers.get("location");
    if (location) {
      let next = location;
      try {
        const u = new URL(location, UPSTREAM);
        if (u.hostname === "ojbyvjqurlamplmujmyu.supabase.co") {
          next = "/" + (u.search || "");
          if (u.searchParams.get("host") === "1") next = "/?host=1";
        }
      } catch {}
      res.setHeader("location", next);
    }

    res.setHeader("cache-control", "no-store, max-age=0");
    res.setHeader("x-nexforge-host", "vercel");
    res.setHeader("content-type", looksHtml ? "text/html; charset=utf-8" : (r.headers.get("content-type") || "application/octet-stream"));
    res.status(r.status).send(raw);
  } catch (error) {
    res.status(502).json({ error: "nexforge_proxy_failed", detail: String(error?.message || error) });
  }
}
