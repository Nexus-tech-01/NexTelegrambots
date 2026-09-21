import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const root = path.resolve(process.env.NEXUS_ROOT || process.cwd());
const port = Number(process.env.NEXMETA_SESSION_PORT || 10003);
const publicBaseUrl = String(process.env.NEXUS_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
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
let restarting = false;

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function ensureSetupToken() {
  if (setupToken && Date.now() < setupExpiresAt) return setupToken;
  setupToken = randomToken();
  setupExpiresAt = Date.now() + setupTtlMs;
  const route = `/nexmeta/session/setup/${setupToken}`;
  console.log('[NexMeta Session] setup required', {
    expiresAt: new Date(setupExpiresAt).toISOString(),
    url: publicBaseUrl ? publicBaseUrl + route : route
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
    return await page.evaluate(() => {
      const loginForm = document.querySelector(
        'input[name="email"],input[name="pass"],form[action*="login"]'
      );
      const bodyText = String(document.body?.innerText || '').toLowerCase();
      const loginWords =
        bodyText.includes('log in') ||
        bodyText.includes('se connecter') ||
        bodyText.includes('connexion');
      const hasAccountUi = Boolean(
        document.querySelector(
          'a[href*="/me/"],a[href*="/profile.php"],[aria-label*="Account"],[aria-label*="Compte"]'
        )
      );
      return !loginForm && (hasAccountUi || !loginWords);
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

async function openBrowser() {
  await mkdir(profileDir, { recursive: true });

  browser = await puppeteer.launch({
    headless: true,
    userDataDir: profileDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-networking=false',
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
    if (!restarting) {
      restartBrowser('disconnected').catch(() => {});
    }
  });

  const pages = await browser.pages();
  page = pages[0] || await browser.newPage();

  await page.setUserAgent(
    process.env.NEXMETA_SESSION_USER_AGENT ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
  );

  const current = page.url();
  if (!current || current === 'about:blank') {
    await page.goto('https://www.facebook.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    }).catch(() => {});
  }

  await refreshContext();
}

async function restartBrowser(reason) {
  if (restarting) return;
  restarting = true;
  console.warn('[NexMeta Session] restarting browser', { reason });

  try {
    if (browser) {
      await browser.close().catch(() => {});
    }
  } catch {}

  browser = null;
  page = null;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await openBrowser();
      restarting = false;
      return;
    } catch (error) {
      console.error('[NexMeta Session] launch failed', {
        attempt,
        error: String(error?.message || error)
      });
      await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 1500 * attempt)));
    }
  }

  restarting = false;
}

function authorizedTokenFromPath(pathname) {
  const match = String(pathname || '').match(/^\/nexmeta\/session\/(?:setup|screenshot|input)\/([^/]+)$/);
  return match?.[1] || '';
}

function setupAuthorized(pathname) {
  const token = authorizedTokenFromPath(pathname);
  return Boolean(
    setupToken &&
    Date.now() < setupExpiresAt &&
    timingSafeEqualText(token, setupToken)
  );
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 32_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('payload_too_large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function renderSetupHtml(token) {
  const esc = JSON.stringify(token);
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NexMeta Facebook Setup</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#0b0b0d;color:#fff}
main{max-width:1100px;margin:auto;padding:14px}
.card{background:#151518;border:1px solid #2b2b30;border-radius:16px;padding:12px}
#screen{width:100%;border-radius:12px;background:#222;touch-action:none}
.controls{display:grid;grid-template-columns:1fr auto auto auto;gap:8px;margin-top:10px}
input,button{font:inherit;padding:12px;border-radius:10px;border:1px solid #34343a}
input{background:#0d0d10;color:#fff}
button{background:#27272d;color:#fff}
small{color:#aaa}
</style>
</head>
<body>
<main>
<h2>NexMeta — connexion Facebook</h2>
<p>Cette page pilote le navigateur Facebook du serveur. Ton mot de passe est saisi directement dans la session distante et n'est pas enregistré par NexMeta.</p>
<div class="card">
<img id="screen" alt="Facebook distant">
<div class="controls">
<input id="text" type="password" placeholder="Texte à saisir dans le champ sélectionné">
<button id="type">Saisir</button>
<button id="tab">Tab</button>
<button id="enter">Entrée</button>
</div>
<p><small>Appuie sur l'image pour sélectionner un champ ou un bouton, puis utilise les contrôles ci-dessus.</small></p>
</div>
</main>
<script>
const token=${esc};
const screen=document.getElementById('screen');
async function refresh(){
  const r=await fetch('/nexmeta/session/screenshot/'+token,{cache:'no-store'});
  if(r.status===410){document.body.innerHTML='<main><h2>Session configurée ou lien expiré.</h2></main>';return}
  if(r.ok){screen.src=URL.createObjectURL(await r.blob())}
}
async function send(body){
  const r=await fetch('/nexmeta/session/input/'+token,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body)
  });
  if(!r.ok)throw new Error(await r.text());
  setTimeout(refresh,300);
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://nexmeta-session.local');

    if (url.pathname === '/nexmeta/session/health') {
      const ctx = await refreshContext();
      return json(res, 200, {
        ok: true,
        browserRunning: Boolean(browser?.connected),
        pageReady: Boolean(page && !page.isClosed()),
        loggedIn: Boolean(ctx?.loggedIn),
        setupRequired: !ctx?.loggedIn,
        setupExpiresAt: setupToken ? new Date(setupExpiresAt).toISOString() : null,
        context: ctx || lastContext
      });
    }

    if (url.pathname.startsWith('/nexmeta/session/setup/')) {
      if (!setupAuthorized(url.pathname)) {
        res.statusCode = 410;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        return res.end('Lien expiré ou invalide.');
      }

      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      return res.end(renderSetupHtml(authorizedTokenFromPath(url.pathname)));
    }

    if (url.pathname.startsWith('/nexmeta/session/screenshot/')) {
      if (!setupAuthorized(url.pathname)) {
        res.statusCode = 410;
        return res.end();
      }
      if (!page || page.isClosed()) return json(res, 503, { error: 'browser_not_ready' });

      const shot = await page.screenshot({ type: 'jpeg', quality: 72 });
      res.statusCode = 200;
      res.setHeader('content-type', 'image/jpeg');
      res.setHeader('cache-control', 'no-store');
      return res.end(shot);
    }

    if (url.pathname.startsWith('/nexmeta/session/input/')) {
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      if (!setupAuthorized(url.pathname)) return json(res, 410, { error: 'expired' });
      if (!page || page.isClosed()) return json(res, 503, { error: 'browser_not_ready' });

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
        if (text.length > 500) return json(res, 400, { error: 'text_too_long' });
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
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    return json(res, 500, {
      error: 'session_agent_error',
      message: String(error?.message || error).slice(0, 200)
    });
  }
});

server.listen(port, '127.0.0.1', async () => {
  console.log('[NexMeta Session] listening', { port, profileDir });
  await restartBrowser('startup');
});

setInterval(() => {
  refreshContext().catch(() => {});
}, 30_000).unref();

process.once('SIGTERM', async () => {
  await browser?.close().catch(() => {});
  server.close(() => process.exit(0));
});

process.once('SIGINT', async () => {
  await browser?.close().catch(() => {});
  server.close(() => process.exit(0));
});
