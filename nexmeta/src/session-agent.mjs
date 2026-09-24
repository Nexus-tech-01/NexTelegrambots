import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

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
let lastLoginState = false;
let lastContext = null;
let launchPromise = null;

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function writeJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(value));
}

async function readJson(req, limit = 32_000) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('payload_too_large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function setupPath(token) {
  return `/nexmeta/session/setup/${token}`;
}

function ensureSetupToken() {
  if (setupToken && Date.now() < setupExpiresAt) return setupToken;

  setupToken = randomToken();
  setupExpiresAt = Date.now() + setupTtlMs;

  console.log('[NexMeta Session] authentication required', {
    expiresAt: new Date(setupExpiresAt).toISOString(),
    setupUrl: publicBaseUrl
      ? publicBaseUrl + setupPath(setupToken)
      : setupPath(setupToken)
  });

  return setupToken;
}

function clearSetupToken() {
  setupToken = null;
  setupExpiresAt = 0;
}

async function isLoggedIn() {
  if (!page || page.isClosed()) return false;

  try {
    const currentUrl = String(page.url() || '').toLowerCase();
    if (
      currentUrl.includes('/login') ||
      currentUrl.includes('/checkpoint') ||
      currentUrl.includes('/recover')
    ) {
      return false;
    }

    const cookies = await page.cookies('https://www.facebook.com/');
    const cUser = cookies.find(
      cookie => cookie.name === 'c_user' && String(cookie.value || '').trim()
    );

    if (!cUser) return false;

    return await page.evaluate(() => {
      const loginForm = document.querySelector(
        'input[name="email"],input[name="pass"],form[action*="login"]'
      );

      if (loginForm) return false;

      const body = String(document.body?.innerText || '').toLowerCase();
      return !(
        body.includes('log in to facebook') ||
        body.includes('se connecter à facebook')
      );
    });
  } catch {
    return false;
  }
}

async function refreshContext() {
  if (!page || page.isClosed()) return null;

  try {
    const context = {
      url: page.url(),
      title: await page.title().catch(() => ''),
      loggedIn: await isLoggedIn(),
      observedAt: new Date().toISOString()
    };

    lastContext = context;

    if (context.loggedIn) {
      if (!lastLoginState) {
        console.log('[NexMeta Session] Facebook session authenticated');
      }
      lastLoginState = true;
      clearSetupToken();
    } else {
      if (lastLoginState) {
        console.warn('[NexMeta Session] Facebook session requires authentication');
      }
      lastLoginState = false;
      ensureSetupToken();
    }

    return context;
  } catch {
    return null;
  }
}

async function launchBrowser() {
  if (browser?.connected && page && !page.isClosed()) return;
  if (launchPromise) return launchPromise;

  launchPromise = (async () => {
    await mkdir(profileDir, { recursive: true });

    const executablePath = await chromium.executablePath();

    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      userDataDir: profileDir,
      args: [
        ...chromium.args,
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
        '--window-size=1280,900'
      ],
      defaultViewport: chromium.defaultViewport || {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1
      }
    });

    browser.on('disconnected', () => {
      browser = null;
      page = null;
      setTimeout(() => {
        launchBrowser().catch(error => {
          console.error('[NexMeta Session] relaunch failed', String(error?.message || error));
        });
      }, 2000).unref();
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

    await refreshContext();
  })().finally(() => {
    launchPromise = null;
  });

  return launchPromise;
}

function tokenFromPath(pathname) {
  const match = String(pathname || '').match(
    /^\/nexmeta\/session\/(?:setup|screenshot|input)\/([^/]+)$/
  );

  return match?.[1] || '';
}

function setupAuthorized(pathname) {
  const token = tokenFromPath(pathname);

  return Boolean(
    setupToken &&
    Date.now() < setupExpiresAt &&
    timingSafeEqualText(token, setupToken)
  );
}

function securityHeaders(res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-robots-tag', 'noindex, nofollow');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader(
    'content-security-policy',
    "default-src 'self' blob:; img-src 'self' blob: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
}

function setupHtml(token) {
  const safeToken = JSON.stringify(token);

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>NexMeta · Facebook Session</title>
<style>
html{background:#08090b;color:#f5f5f7;font-family:system-ui,-apple-system,sans-serif}
body{margin:0;padding:18px}
main{max-width:1100px;margin:auto}
h1{margin:6px 0 8px;font-size:28px}
p{color:#aaa;line-height:1.5}
.card{background:#121216;border:1px solid #292a31;border-radius:18px;padding:12px}
#screen{display:block;width:100%;border-radius:12px;background:#222;touch-action:none}
.controls{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:8px;margin-top:10px}
input,button{font:inherit;padding:12px;border-radius:10px;border:1px solid #363740}
input{background:#090a0d;color:#fff}
button{background:#272932;color:#fff}
small{color:#85858c}
@media(max-width:680px){.controls{grid-template-columns:1fr 1fr}.controls input{grid-column:1/-1}}
</style>
</head>
<body>
<main>
<small>NEXMETA · PERSISTENT SESSION</small>
<h1>Connexion Facebook du serveur</h1>
<p>
Le navigateur ci-dessous tourne sur ton serveur. Clique dans la capture pour sélectionner
un champ Facebook, puis utilise la zone de saisie. NexMeta ne sauvegarde pas le mot de passe :
seul le profil Chromium persistant conserve la session créée par Facebook.
</p>
<div class="card">
<img id="screen" alt="Navigateur Facebook distant">
<div class="controls">
<input id="text" type="password" placeholder="Texte à saisir dans le champ sélectionné">
<button id="type">Saisir</button>
<button id="tab">Tab</button>
<button id="enter">Entrée</button>
</div>
</div>
</main>
<script>
const token=${safeToken};
const screen=document.getElementById('screen');
let lastUrl=null;

async function refresh(){
  const r=await fetch('/nexmeta/session/screenshot/'+token,{cache:'no-store'});
  if(r.status===410){
    document.body.innerHTML='<main><h1>Session configurée ou lien expiré.</h1><p>Tu peux fermer cette page.</p></main>';
    return;
  }
  if(!r.ok)return;
  const blob=await r.blob();
  if(lastUrl)URL.revokeObjectURL(lastUrl);
  lastUrl=URL.createObjectURL(blob);
  screen.src=lastUrl;
}

async function send(body){
  const r=await fetch('/nexmeta/session/input/'+token,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body)
  });
  if(!r.ok)throw new Error(await r.text());
  setTimeout(refresh,250);
}

screen.addEventListener('click',e=>{
  const rect=screen.getBoundingClientRect();
  const x=(e.clientX-rect.left)/rect.width*screen.naturalWidth;
  const y=(e.clientY-rect.top)/rect.height*screen.naturalHeight;
  send({action:'click',x,y}).catch(()=>{});
});

document.getElementById('type').onclick=()=>{
  const el=document.getElementById('text');
  const value=el.value;
  el.value='';
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

export async function persistentSessionStatus() {
  try {
    await launchBrowser();
    const context = await refreshContext();

    return {
      ok: true,
      browserRunning: Boolean(browser?.connected),
      pageReady: Boolean(page && !page.isClosed()),
      loggedIn: Boolean(context?.loggedIn),
      setupRequired: !context?.loggedIn,
      setupExpiresAt:
        setupToken && setupExpiresAt > Date.now()
          ? new Date(setupExpiresAt).toISOString()
          : null,
      context: context || lastContext
    };
  } catch (error) {
    return {
      ok: false,
      browserRunning: false,
      loggedIn: false,
      setupRequired: true,
      error: String(error?.message || error).slice(0, 300)
    };
  }
}

export async function handlePersistentSessionRequest(req, res, pathname) {
  try {
    await launchBrowser();

    if (pathname === '/nexmeta/session/health') {
      return writeJson(res, 200, await persistentSessionStatus());
    }

    if (pathname === '/nexmeta/session/setup') {
      const context = await refreshContext();
      if (context?.loggedIn) {
        return writeJson(res, 200, {
          ok: true,
          loggedIn: true,
          setupRequired: false
        });
      }

      const token = ensureSetupToken();
      return writeJson(res, 200, {
        ok: true,
        loggedIn: false,
        setupRequired: true,
        setupUrl: publicBaseUrl
          ? publicBaseUrl + setupPath(token)
          : setupPath(token),
        expiresAt: new Date(setupExpiresAt).toISOString()
      });
    }

    if (pathname.startsWith('/nexmeta/session/setup/')) {
      if (!setupAuthorized(pathname)) {
        res.statusCode = 410;
        securityHeaders(res);
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        return res.end('Lien expiré ou invalide.');
      }

      res.statusCode = 200;
      securityHeaders(res);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(setupHtml(tokenFromPath(pathname)));
    }

    if (pathname.startsWith('/nexmeta/session/screenshot/')) {
      if (!setupAuthorized(pathname)) {
        res.statusCode = 410;
        securityHeaders(res);
        return res.end();
      }

      if (!page || page.isClosed()) {
        return writeJson(res, 503, { error: 'browser_not_ready' });
      }

      const shot = await page.screenshot({
        type: 'jpeg',
        quality: 72
      });

      res.statusCode = 200;
      securityHeaders(res);
      res.setHeader('content-type', 'image/jpeg');
      return res.end(shot);
    }

    if (pathname.startsWith('/nexmeta/session/input/')) {
      if (req.method !== 'POST') {
        return writeJson(res, 405, { error: 'method_not_allowed' });
      }

      if (!setupAuthorized(pathname)) {
        return writeJson(res, 410, { error: 'expired' });
      }

      if (!page || page.isClosed()) {
        return writeJson(res, 503, { error: 'browser_not_ready' });
      }

      const body = await readJson(req);
      const action = String(body.action || '');

      if (action === 'click') {
        const x = Number(body.x);
        const y = Number(body.y);

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return writeJson(res, 400, { error: 'invalid_coordinates' });
        }

        await page.mouse.click(x, y);
      } else if (action === 'type') {
        const text = String(body.text || '');

        if (text.length > 500) {
          return writeJson(res, 400, { error: 'text_too_long' });
        }

        await page.keyboard.type(text, { delay: 20 });
      } else if (action === 'key') {
        const key = String(body.key || '');

        if (!['Tab', 'Enter', 'Escape', 'Backspace'].includes(key)) {
          return writeJson(res, 400, { error: 'key_not_allowed' });
        }

        await page.keyboard.press(key);
      } else {
        return writeJson(res, 400, { error: 'unsupported_action' });
      }

      await new Promise(resolve => setTimeout(resolve, 250));
      const context = await refreshContext();

      return writeJson(res, 200, {
        ok: true,
        loggedIn: Boolean(context?.loggedIn)
      });
    }

    return writeJson(res, 404, { error: 'not_found' });
  } catch (error) {
    return writeJson(
      res,
      Number(error?.status) || 500,
      {
        error: 'persistent_session_error',
        message: String(error?.message || error).slice(0, 300)
      }
    );
  }
}

setInterval(() => {
  if (!browser?.connected) return;
  refreshContext().catch(() => {});
}, 30_000).unref();
