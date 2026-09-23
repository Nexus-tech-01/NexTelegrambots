const TARGET = "https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexcontrol";
const PREFIX = "/functions/v1/nexcontrol-ui";

function routePath(url: URL) {
  const p = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname;
  return p && p.startsWith("/") ? p : "/" + (p || "");
}

function copyRequestHeaders(req: Request, path: string) {
  const h = new Headers(req.headers);
  for (const k of ["host","content-length","connection","transfer-encoding","keep-alive","upgrade","proxy-connection","te","trailer"]) h.delete(k);
  h.set("x-nexcontrol-path", path);
  h.set("accept-encoding", "identity");
  return h;
}

function rewriteHtml(html: string) {
  return html.replace(/(["'`])\/(?!\/)/g, (_m, q) => q + PREFIX + "/");
}

Deno.serve(async (req: Request) => {
  try {
    const u = new URL(req.url);
    const path = routePath(u);
    const headers = copyRequestHeaders(req, path);
    const body = (req.method === "GET" || req.method === "HEAD") ? undefined : await req.arrayBuffer();

    const upstream = await fetch(TARGET + u.search, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });

    const out = new Headers(upstream.headers);
    for (const k of ["content-length","content-encoding","transfer-encoding","connection"]) out.delete(k);

    const loc = upstream.headers.get("location");
    if (loc?.startsWith("/")) out.set("location", u.origin + PREFIX + loc);

    const isUi = (req.method === "GET" || req.method === "HEAD") && !path.startsWith("/api/");
    if (isUi) {
      out.set("content-type", "text/html; charset=utf-8");
      out.set("cache-control", "no-store, max-age=0");
      out.set("x-content-type-options", "nosniff");
      out.set("referrer-policy", "same-origin");
      out.set("content-security-policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' https: data:; font-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    }

    if (req.method === "HEAD") return new Response(null, { status: upstream.status, headers: out });

    const bytes = new Uint8Array(await upstream.arrayBuffer());
    if (!isUi) return new Response(bytes, { status: upstream.status, headers: out });

    return new Response(rewriteHtml(new TextDecoder().decode(bytes)), {
      status: upstream.status,
      headers: out,
    });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      error: "nexcontrol_ui_proxy_failed",
      detail: String((err as Error)?.message || err),
    }), {
      status: 502,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
});