import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const root = path.resolve(process.env.NEXUS_ROOT || process.cwd());
const publicBaseUrl = String(
  process.env.NEXUS_PUBLIC_BASE_URL ||
  process.env.NEXMETA_PUBLIC_BASE_URL ||
  ''
).replace(/\/+$/, '');

const profileDir = path.resolve(
  process.env.NEXMETA_SESSION_PROFILE_DIR ||
  path.join(root, '.nexmeta-browser-profile')
);

const setupTtlMs = Math.max(
  5 * 60_000,
  Number(process.env.NEXMETA_SESSION_SETUP_TTL_MS || 30 * 60_000)
);

let browser = null;
let page = null;
let setupToken = null;
let setupExpiresAt = 0;
let lastContext = null;
let loginState = false;
let starting = null;
let restartTimer = null;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

function securityHeaders(res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-robots-tag', 'noindex, nofollow');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function issueSetupToken() {
  if (setupToken && Date.now() < setupExpiresAt) return setupToken;
  setupToken = crypto.randomBytes(32).toString('base64url');
  setupExpiresAt = Date.now() + setupTtlMs;
  const route = `/nexmeta/session/setup/${setupToken}`;

  console.log('[NexMeta Session] setup link', {
    expiresAt: new Date(setupExpiresAt).toISOString(),
    url: publicBaseUrl ? publicBaseUrl + route : route
  });

  return setupToken;
}

function clearSetupToken() {
  setupToken = null;
  setupExpiresAt = 0;
}

async function evaluateLoginState() {
  if (!page || page.isClosed()) return false;

  try {
    return await page.evaluate(() => {
      const loginField = document.querySelector(
        'input[name="email"],input[name="pass"],form[action*="login"]'
      );

      const accountUi = document.querySelector(
        'a[href*="/me/"],a[href*="/profile.php"],[aria-label*="Account"],[aria-label*="Compte"]'
      );

      const text = String(document.body?.innerText || '').toLowerCase();
      const obviousLogin =
        text.includes('log in to facebook') ||
        text.includes('se connecter à facebook') ||
        text.includes('connectez-vous à facebook');

      return !loginField && (Boolean(accountUi) || !obviousLogin);
    });
  } catch {
    return false;
  }
}

async function refreshContext() {
  if (!page || page.isClosed()) {
    lastContext = {
      browserRunning: Boolean(browser?.connected),
      pageReady: false,
      loggedIn: false,
      observedAt: new Date().toISOString()
    };
    return lastContext;
  }

  const loggedIn = await evaluateLoginState();
  const context = {
    browserRunning: Boolean(browser?.connected),
    pageReady: true,
    loggedIn,
    url: page.url(),
    title: await page.title().catch(() => ''),
    observedAt: new Date().toISOString()
  };

  if (loggedIn && !loginState) {
    console.log('[NexMeta Session] Facebook session authenticated');
  }

  if (!loggedIn && loginState) {
    console.warn('[NexMeta Session] Facebook session needs authentication');
  }

  loginState = loggedIn;
  lastContext = context;

  if (loggedIn) {
    clearSetupToken();
  } else {
    issueSetupToken();
  }

  return context;
}

function scheduleRestart(reason) {
  if (restartTimer) return;
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    console.warn('[NexMeta Session] restarting browser', { reason });
    await startPersistentSession(true).catch(error => {
      console.error('[NexMeta Session] restart failed', {
        error: String(error?.message || error)
      });
      scheduleRestart('retry');
    });
  }, 3000);
  restartTimer.unref?.();
}

export async function startPersistentSession(force = false) {
  if (starting) return starting;
  if (!force && browser?.connected && page && !page.isClosed()) {
    return refreshContext();
  }

  starting = (async () => {
    if (browser) {
      await browser.close().catch(() => {});
    }

    browser = null;
    page = null;

    await mkdir(profileDir, { recursive: true });

    browser = await puppeteer.launch({
      headless: true,
      userDataDir: profileDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
        '--window-size=1280,900'
      ],
      defaultViewport: {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1
      }
    });

    browser.on('disconnected', () => {
      browser = null;
      page = null;
      scheduleRestart('browser_disconnected');
    });

    const pages = await browser.pages();
    page = pages[0] || await browser.newPage();

    await page.setUserAgent(
      process.env.NEXMETA_SESSION_USER_AGENT ||
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    );

    if (!page.url() || page.url() === 'about:blank') {
      await page.goto('https://www.facebook.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000
      }).catch(() => {});
    }

    return refreshContext();
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export async function persistentSessionStatus() {
  if (!browser?.connected || !page || page.isClosed()) {
    await startPersistentSession().catch(() => {});
  }

  const context = await refreshContext().catch(() => lastContext);

  return {
    ok: Boolean(browser?.connected && page && !page.isClosed()),
    browserRunning: Boolean(browser?.connected),
    pageReady: Boolean(page && !page.isClosed()),
    loggedIn: Boolean(context?.loggedIn),
    setupRequired: !context?.loggedIn,
    setupExpiresAt:
      setupToken && Date.now() < setupExpiresAt
        ? new Date(setupExpiresAt).toISOString()
        : null,
    context
  };
}

function tokenFromPath(pathname) {
  const match = String(pathname || '').match(
    /^\/nexmeta\/session\/(?:setup|screenshot|input)\/([^/]+)$/
  );
  return match?.[1] || '';
}

function tokenValid(pathname) {
  const supplied = tokenFromPath(pathname);
  return Boolean(
    supplied &&
    setupToken &&
    Date.now() < setupExpiresAt &&
    safeEqual(supplied, setupToken)
  );
}

async function readJson(req, maxBytes = 32 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('payload_too_large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function setupHtml(token) {
  const safeToken = JSON.stringify(token);

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>NexMeta · Facebook H24</title>
<style>
html{background:#09090b;color:#f5f5f5;font-family:system-ui,-apple-system,sans-serif}
body{margin:0;padding:16px}
main{max-width:1080px;margin:auto}
.card{background:#141417;border:1px solid #2b2b31;border-radius:18px;padding:12px}
#screen{display:block;width:100%;border-radius:12px;background:#222;touch-action:none}
.controls{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:8px;margin-top:10px}
input,button{font:inherit;padding:12px;border-radius:11px;border:1px solid #35353b}
input{background:#0b0b0e;color:#fff;min-width:0}
button{background:#25252b;color:#fff}
p{color:#aaa;line-height:1.5}
small{color:#888}
</style>
</head>
<body>
<main>
<h2>NexMeta — connexion Facebook persistante</h2>
<p>Tu contrôles ici le navigateur Facebook qui tourne sur le serveur. Les caractères saisis sont envoyés directement au navigateur distant et ne sont pas écrits dans les logs par NexMeta.</p>
<div class="card">
<img id="screen" alt="Navigateur Facebook distant">
<div class="controls">
<input id="text" type="password" autocomplete="off" placeholder="Texte à saisir dans le champ sélectionné">
<button id="type">Saisir</button>
<button id="tab">Tab</button>
<button id="enter">Entrée</button>
</div>
<p><small>Touche l'image pour sélectionner le champ ou le bouton voulu. Le lien s'invalide automatiquement après connexion.</small></p>
</div>
</main>
<script>
const token=${safeToken};
const screen=document.getElementById('screen');
async function refresh(){
  const r=await fetch('/nexmeta/session/screenshot/'+token,{cache:'no-store'});
  if(r.status===410){
    document.body.innerHTML='<main><h2>Connexion terminée ou lien expiré.</h2></main>';
    return;
  }
  if(r.ok){
    const blob=await r.blob();
    const old=screen.src;
    screen.src=URL.createObjectURL(blob);
    if(old.startsWith('blob:')) URL.revokeObjectURL(old);
  }
}
async function send(body){
  const r=await fetch('/nexmeta/session/input/'+token,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body)
  });
  if(!r.ok) throw new Error(await r.text());
  setTimeout(refresh,250);
}
screen.addEventListener('click',e=>{
  const rect=screen.getBoundingClientRect();
  send({
    action:'click',
    x:(e.clientX-rect.left)/rect.width*screen.naturalWidth,
    y:(e.clientY-rect.top)/rect.height*screen.naturalHeight
  }).catch(()=>{});
});
document.getElementById('type').onclick=()=>{
  const input=document.getElementById('text');
  const value=input.value;
  input.value='';
  send({action:'type',text:value}).catch(()=>{});
};
document.getElementById('tab').onclick=()=>send({action:'key',key:'Tab'}).catch(()=>{});
document.getElementById('enter').onclick=()=>send({action:'key',key:'Enter'}).catch(()=>{});
setInterval(refresh,1200);
refresh();
</script>
</body>
</html>`;
}

export async function handlePersistentSessionRequest(req, res, pathname) {
  await startPersistentSession().catch(() => {});

  if (req.method === 'GET' && pathname === '/nexmeta/session/health') {
    return json(res, 200, await persistentSessionStatus());
  }

  if (pathname.startsWith('/nexmeta/session/setup/')) {
    securityHeaders(res);

    if (!tokenValid(pathname)) {
      res.statusCode = 410;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end('Lien expiré ou invalide.');
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader(
      'content-security-policy',
      "default-src 'self' blob:; img-src 'self' blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
    );
    return res.end(setupHtml(tokenFromPath(pathname)));
  }

  if (pathname.startsWith('/nexmeta/session/screenshot/')) {
    securityHeaders(res);
    if (!tokenValid(pathname)) {
      res.statusCode = 410;
      return res.end();
    }
    if (!page || page.isClosed()) {
      return json(res, 503, { error: 'browser_not_ready' });
    }

    const image = await page.screenshot({
      type: 'jpeg',
      quality: 72
    });

    res.statusCode = 200;
    res.setHeader('content-type', 'image/jpeg');
    return res.end(image);
  }

  if (pathname.startsWith('/nexmeta/session/input/')) {
    securityHeaders(res);

    if (req.method !== 'POST') {
      return json(res, 405, { error: 'method_not_allowed' });
    }

    if (!tokenValid(pathname)) {
      return json(res, 410, { error: 'expired' });
    }

    if (!page || page.isClosed()) {
      return json(res, 503, { error: 'browser_not_ready' });
    }

    const body = await readJson(req);
    const action = String(body.action || '');

    if (action === 'click') {
      const x = Number(body.x);
      const y = Number(body.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return json(res, 400, { error: 'invalid_coordinates' });
      }
      await page.mouse.click(x, y);
    } else if (action === 'type') {
      const text = String(body.text || '');
      if (text.length > 500) {
        return json(res, 400, { error: 'text_too_long' });
      }
      await page.keyboard.type(text, { delay: 20 });
    } else if (action === 'key') {
      const key = String(body.key || '');
      if (!['Tab', 'Enter', 'Escape', 'Backspace'].includes(key)) {
        return json(res, 400, { error: 'key_not_allowed' });
      }
      await page.keyboard.press(key);
    } else {
      return json(res, 400, { error: 'unsupported_action' });
    }

    await new Promise(resolve => setTimeout(resolve, 250));
    await refreshContext();

    return json(res, 200, {
      ok: true,
      loggedIn: loginState
    });
  }

  return json(res, 404, { error: 'not_found' });
}

setInterval(() => {
  refreshContext().catch(() => {
    scheduleRestart('health_check_failed');
  });
}, 30_000).unref();

startPersistentSession().catch(error => {
  console.error('[NexMeta Session] initial start failed', {
    error: String(error?.message || error)
  });
  scheduleRestart('initial_start_failed');
});
