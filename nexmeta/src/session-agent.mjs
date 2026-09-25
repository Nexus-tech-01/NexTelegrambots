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

    const executablePath = process.env.NEXMETA_CHROMIUM_PATH || await chromium.executablePath();

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
        '--lang=fr-FR',
        '--window-size=1440,1400'
      ],
      defaultViewport: {
        width: 1440,
        height: 1400,
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

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.7'
    });

    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(navigator, 'language', {
          configurable: true,
          get: () => 'fr-FR'
        });
        Object.defineProperty(navigator, 'languages', {
          configurable: true,
          get: () => ['fr-FR', 'fr', 'en']
        });
      } catch {}
    });

    await page.setCookie({
      name: 'locale',
      value: 'fr_FR',
      domain: '.facebook.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'Lax'
    }).catch(() => {});

    if (!page.url() || page.url() === 'about:blank' || /facebook\.com/i.test(page.url())) {
      await page.goto('https://www.facebook.com/?locale=fr_FR', {
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
    /^\/nexmeta\/session\/(?:setup|screenshot|captcha|input)\/([^/]+)$/
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

async function captchaClipBox() {
  if (!page || page.isClosed()) return null;

  const candidates = [];
  for (const frame of page.frames()) {
    const url = String(frame.url() || '').toLowerCase();
    if (!url.includes('recaptcha') && !url.includes('/captcha/')) continue;

    const element = await frame.frameElement().catch(() => null);
    if (!element) continue;

    const box = await element.boundingBox().catch(() => null);
    if (!box || box.width < 40 || box.height < 40) continue;

    const priority =
      url.includes('fbsbx.com/captcha') ? 3 :
      url.includes('/bframe') ? 2 :
      1;

    candidates.push({ box, priority });
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) =>
    (b.priority - a.priority) ||
    (b.box.width * b.box.height - a.box.width * a.box.height)
  );

  const box = candidates[0].box;
  const viewport = page.viewport() || { width: 1440, height: 1400 };
  const pad = 18;

  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const width = Math.max(
    1,
    Math.min(viewport.width - x, Math.ceil(box.width + pad * 2))
  );
  const height = Math.max(
    1,
    Math.min(viewport.height - y, Math.ceil(box.height + pad * 2))
  );

  return { x, y, width, height };
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
#viewport{width:100%;height:72vh;overflow:auto;border-radius:14px;border:1px solid #2d3340;background:#050608;-webkit-overflow-scrolling:touch}
#stage{min-width:100%;min-height:100%;display:flex;align-items:flex-start;justify-content:flex-start}
#screen{display:block;max-width:none;height:auto;border-radius:12px;background:#222;user-select:none;-webkit-user-drag:none;touch-action:none}
#captchaPanel{display:none;margin:10px 0;padding:12px;border:1px solid #3a4150;border-radius:14px;background:#0b0e14}
#captchaPanel p{margin:6px 0 10px}
#captchaViewport{width:100%;overflow:auto;border-radius:12px;background:#050608;border:1px solid #2d3340}
#captchaScreen{display:block;width:100%;height:auto;max-width:none;user-select:none;-webkit-user-drag:none;touch-action:none}
.controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}
.quick{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:10px 0}
.viewerTools{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:10px 0}
.status{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0;color:#999;font-size:12px}
.badge{padding:5px 8px;border-radius:999px;background:#0c1018;border:1px solid #242937}
input,button{font:inherit;padding:12px;border-radius:10px;border:1px solid #363740}
input{background:#090a0d;color:#fff}
button{background:#272932;color:#fff}
small{color:#85858c}
@media(max-width:680px){.quick,.viewerTools{grid-template-columns:1fr 1fr}.controls{grid-template-columns:1fr 1fr}.controls input{grid-column:1/-1}#viewport{height:68vh}}
</style>
</head>
<body>
<main>
<small>NEXMETA · PERSISTENT SESSION</small>
<h1>Connexion Facebook du serveur</h1>
<p>
Le navigateur Facebook ci-dessous tourne directement sur ton serveur. Utilise les boutons
<b>E-mail</b> et <b>Mot de passe</b> pour sélectionner automatiquement le bon champ, saisis
la valeur dans la zone prévue puis appuie sur <b>Saisir</b>. Ensuite appuie sur
<b>Connexion</b>. Si Facebook demande un code 2FA ou une confirmation, utilise la capture
comme un navigateur distant. NexMeta ne journalise pas les identifiants saisis.
</p>
<div class="card">
<div id="captchaPanel">
<strong>Validation reCAPTCHA</strong>
<p>Quand Facebook affiche le test, touche directement cette zone. Elle est séparée du grand écran pour que les taps arrivent au bon endroit.</p>
<div id="captchaViewport"><img id="captchaScreen" alt="reCAPTCHA Facebook"></div>
<div class="status"><span class="badge" id="captchaState">CAPTCHA : détection…</span></div>
</div>
<div class="viewerTools">
<button id="refresh">Actualiser</button>
<button id="zoomOut">Zoom −</button>
<button id="fit">Ajuster</button>
<button id="zoomIn">Zoom +</button>
<button id="fullscreen">Plein écran</button>
</div>
<div id="viewport"><div id="stage"><img id="screen" alt="Navigateur Facebook distant"></div></div>
<div class="status">
<span class="badge" id="zoomLabel">Zoom : --</span>
<span class="badge" id="sizeLabel">Image : --</span>
<span class="badge" id="liveLabel">État : chargement…</span>
</div>
<div class="quick">
<button id="email">E-mail</button>
<button id="password">Mot de passe</button>
<button id="login">Connexion</button>
<button id="french">Forcer le français</button>
</div>
<div class="controls">
<input id="text" type="password" autocomplete="off" placeholder="Valeur à saisir dans le champ sélectionné">
<button id="type">Saisir</button>
<button id="tab">Champ suivant</button>
<button id="enter">Entrée</button>
</div>
</div>
</main>
<script>
const token=${safeToken};
const screen=document.getElementById('screen');
const captchaPanel=document.getElementById('captchaPanel');
const captchaScreen=document.getElementById('captchaScreen');
const captchaState=document.getElementById('captchaState');
const viewport=document.getElementById('viewport');
const zoomLabel=document.getElementById('zoomLabel');
const sizeLabel=document.getElementById('sizeLabel');
const liveLabel=document.getElementById('liveLabel');
let lastUrl=null;
let naturalWidth=0;
let naturalHeight=0;
let zoom=1;
let initialized=false;
let interactionPauseUntil=0;
let captchaUrl=null;

function setLive(t){liveLabel.textContent='État : '+t}
function clamp(v,min,max){return Math.max(min,Math.min(max,v))}
function applyZoom(next,keepCenter=true){
  if(!naturalWidth||!naturalHeight)return;
  const oldW=screen.getBoundingClientRect().width||1;
  const oldH=screen.getBoundingClientRect().height||1;
  const cx=viewport.scrollLeft+viewport.clientWidth/2;
  const cy=viewport.scrollTop+viewport.clientHeight/2;
  zoom=clamp(next,0.35,4);
  screen.style.width=Math.round(naturalWidth*zoom)+'px';
  screen.style.height='auto';
  zoomLabel.textContent='Zoom : '+Math.round(zoom*100)+'%';
  if(keepCenter){
    requestAnimationFrame(()=>{
      const nw=screen.getBoundingClientRect().width||1;
      const nh=screen.getBoundingClientRect().height||1;
      viewport.scrollLeft=(cx/oldW)*nw-viewport.clientWidth/2;
      viewport.scrollTop=(cy/oldH)*nh-viewport.clientHeight/2;
    });
  }
}
function fit(){
  if(!naturalWidth)return;
  const z=Math.max(.35,(viewport.clientWidth-4)/naturalWidth);
  applyZoom(z,false);
  viewport.scrollLeft=0;
  viewport.scrollTop=0;
}

async function refresh(){
  if(Date.now()<interactionPauseUntil)return;
  try{
    setLive('chargement…');
    const r=await fetch('/nexmeta/session/screenshot/'+token,{cache:'no-store'});
    if(r.status===410){
      document.body.innerHTML='<main><h1>Session configurée ou lien expiré.</h1><p>Tu peux fermer cette page.</p></main>';
      return;
    }
    if(!r.ok){setLive('erreur '+r.status);return}
    const blob=await r.blob();
    if(lastUrl)URL.revokeObjectURL(lastUrl);
    lastUrl=URL.createObjectURL(blob);
    const img=new Image();
    img.onload=()=>{
      naturalWidth=img.naturalWidth;
      naturalHeight=img.naturalHeight;
      sizeLabel.textContent='Image : '+naturalWidth+'×'+naturalHeight;
      screen.src=lastUrl;
      if(!initialized){initialized=true;fit()}else{applyZoom(zoom,false)}
      setLive('capture reçue');
    };
    img.onerror=()=>setLive('image illisible');
    img.src=lastUrl;
  }catch{setLive('erreur réseau')}
}

async function refreshCaptcha(){
  if(Date.now()<interactionPauseUntil)return;
  try{
    const r=await fetch('/nexmeta/session/captcha/'+token,{cache:'no-store'});
    if(r.status===204){
      captchaPanel.style.display='none';
      return;
    }
    if(r.status===410){
      captchaPanel.style.display='none';
      return;
    }
    if(!r.ok){
      captchaState.textContent='CAPTCHA : erreur '+r.status;
      return;
    }
    const blob=await r.blob();
    if(captchaUrl)URL.revokeObjectURL(captchaUrl);
    captchaUrl=URL.createObjectURL(blob);
    captchaScreen.src=captchaUrl;
    captchaPanel.style.display='block';
    captchaState.textContent='CAPTCHA : prêt — touche directement l’image';
  }catch{
    captchaState.textContent='CAPTCHA : erreur réseau';
  }
}

async function send(body){
  interactionPauseUntil=Date.now()+1800;
  const r=await fetch('/nexmeta/session/input/'+token,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body)
  });
  if(!r.ok)throw new Error(await r.text());
  setTimeout(()=>{
    interactionPauseUntil=0;
    refresh();
    refreshCaptcha();
  },850);
}

function bindTap(img,action){
  let down=null;
  img.addEventListener('pointerdown',e=>{
    down={x:e.clientX,y:e.clientY,id:e.pointerId};
    interactionPauseUntil=Date.now()+2500;
    try{img.setPointerCapture(e.pointerId)}catch{}
  });
  img.addEventListener('pointercancel',()=>{down=null;interactionPauseUntil=0});
  img.addEventListener('pointerup',e=>{
    if(!down||down.id!==e.pointerId)return;
    const moved=Math.hypot(e.clientX-down.x,e.clientY-down.y);
    down=null;
    if(moved>18){
      interactionPauseUntil=0;
      return;
    }
    const rect=img.getBoundingClientRect();
    if(!rect.width||!rect.height||!img.naturalWidth||!img.naturalHeight){
      interactionPauseUntil=0;
      return;
    }
    const x=(e.clientX-rect.left)/rect.width*img.naturalWidth;
    const y=(e.clientY-rect.top)/rect.height*img.naturalHeight;
    send({action,x,y}).catch(()=>{
      interactionPauseUntil=0;
    });
  });
}

bindTap(screen,'click');
bindTap(captchaScreen,'captcha_click');

document.getElementById('refresh').onclick=()=>refresh();
document.getElementById('zoomIn').onclick=()=>applyZoom(zoom+.25);
document.getElementById('zoomOut').onclick=()=>applyZoom(zoom-.25);
document.getElementById('fit').onclick=()=>fit();
document.getElementById('fullscreen').onclick=async()=>{try{if(!document.fullscreenElement)await viewport.requestFullscreen();else await document.exitFullscreen()}catch{}};

document.getElementById('email').onclick=()=>send({action:'focus',field:'email'}).catch(()=>{});
document.getElementById('password').onclick=()=>send({action:'focus',field:'password'}).catch(()=>{});
document.getElementById('login').onclick=()=>send({action:'submit_login'}).catch(()=>{});
document.getElementById('french').onclick=()=>send({action:'force_french'}).catch(()=>{});

document.getElementById('type').onclick=()=>{
  const el=document.getElementById('text');
  const value=el.value;
  el.value='';
  send({action:'type',text:value}).catch(()=>{});
};
document.getElementById('tab').onclick=()=>send({action:'key',key:'Tab'}).catch(()=>{});
document.getElementById('enter').onclick=()=>send({action:'key',key:'Enter'}).catch(()=>{});

setInterval(()=>{
  refresh();
  refreshCaptcha();
},2500);
refresh();
refreshCaptcha();
</script>
</body>
</html>`;
}


const sessionControlKey = String(
  process.env.NEXMETA_SESSION_CONTROL_KEY || ''
).trim();

function sessionControlAuthorized(req) {
  const supplied = String(req?.headers?.authorization || '')
    .replace(/^Bearer\s+/i, '')
    .trim();

  return Boolean(
    sessionControlKey.length >= 32 &&
    timingSafeEqualText(supplied, sessionControlKey)
  );
}

function supportedFacebookUrl(value) {
  try {
    const url = new URL(String(value || ''), 'https://www.facebook.com/');
    return [
      'facebook.com',
      'www.facebook.com',
      'web.facebook.com',
      'm.facebook.com',
      'messenger.com',
      'www.messenger.com'
    ].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function requireAuthenticatedSession() {
  await launchBrowser();
  const context = await refreshContext();

  if (!context?.loggedIn) {
    const error = new Error('facebook_session_authentication_required');
    error.status = 409;
    throw error;
  }

  return context;
}

async function navigateFacebook(targetUrl) {
  if (!supportedFacebookUrl(targetUrl)) {
    const error = new Error('target_url_not_allowed');
    error.status = 400;
    throw error;
  }

  if (!page || page.isClosed()) {
    const error = new Error('browser_not_ready');
    error.status = 503;
    throw error;
  }

  const target = new URL(String(targetUrl), 'https://www.facebook.com/').toString();
  if (page.url() !== target) {
    await page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    });
    await new Promise(resolve => setTimeout(resolve, 1200));
  }

  return refreshContext();
}

async function browserPageContext() {
  const context = await requireAuthenticatedSession();

  return {
    ...context,
    browserRunning: Boolean(browser?.connected),
    pageReady: Boolean(page && !page.isClosed())
  };
}

async function listBrowserConversations() {
  await requireAuthenticatedSession();

  if (!/\/messages(?:\/|$)/i.test(page.url())) {
    await navigateFacebook('https://www.facebook.com/messages/');
  }

  await page.waitForSelector('body', { timeout: 15_000 });

  return page.evaluate(() => {
    const visible = element => {
      if (!(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    };

    const seen = new Set();
    const conversations = [];

    for (const anchor of document.querySelectorAll('a[href*="/messages/t/"]')) {
      if (!visible(anchor)) continue;

      let href = '';
      try {
        const url = new URL(anchor.href, location.href);
        url.hash = '';
        href = url.toString();
      } catch {
        continue;
      }

      if (seen.has(href)) continue;
      seen.add(href);

      const descendantLabels = [...anchor.querySelectorAll('[aria-label]')]
        .map(node => node.getAttribute('aria-label') || '')
        .filter(Boolean)
        .join(' ');

      const label = String(
        anchor.getAttribute('aria-label') ||
        anchor.innerText ||
        anchor.textContent ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 800);

      const accessibilityText = (label + ' ' + descendantLabels)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1600);

      const unread = /(?:\bunread\b|\bnon\s+lu(?:e)?\b|nouveau(?:x)?\s+message|new\s+message)/i
        .test(accessibilityText);

      const outboundHint = /(?:^|\s)(?:you|vous)\s*[:：]|vous\s+avez\s+envoy[ée]|you\s+sent/i
        .test(accessibilityText);

      conversations.push({
        url: href,
        label: label || null,
        unread,
        outboundHint
      });

      if (conversations.length >= 80) break;
    }

    return {
      url: location.href,
      title: document.title,
      conversations
    };
  });
}

async function readBrowserConversation(threadUrl) {
  await requireAuthenticatedSession();

  if (threadUrl) {
    await navigateFacebook(threadUrl);
  } else if (!/\/messages\/t\//i.test(page.url())) {
    const error = new Error('thread_url_required');
    error.status = 400;
    throw error;
  }

  await page.waitForSelector('body', { timeout: 15_000 });

  return page.evaluate(() => {
    const visible = element => {
      if (!(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    };

    const main =
      document.querySelector('div[role="main"]') ||
      document.querySelector('main') ||
      document.body;

    const seen = new Set();
    const items = [];
    const messages = [];

    const rowCandidates = [
      ...main.querySelectorAll(
        '[data-ad-comet-preview="message"], div[role="row"]'
      )
    ];

    for (const node of rowCandidates) {
      if (!visible(node)) continue;

      const text = String(node.innerText || node.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!text || text.length > 2500 || seen.has(text)) continue;

      const labels = [
        node.getAttribute('aria-label') || '',
        ...[...node.querySelectorAll('[aria-label]')]
          .map(item => item.getAttribute('aria-label') || '')
      ]
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2200);

      const outbound =
        /(?:vous\s+avez\s+envoy[ée]|you\s+sent|sent\s+by\s+you|envoy[ée]\s+par\s+vous)/i
          .test(labels) ||
        /^(?:vous|you)\s*[:：]/i.test(text);

      seen.add(text);
      items.push(text);
      messages.push({
        text,
        outbound,
        accessibility: labels || null
      });

      if (messages.length >= 120) break;
    }

    if (!messages.length) {
      for (const node of main.querySelectorAll('[dir="auto"]')) {
        if (!visible(node)) continue;

        const text = String(node.innerText || node.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();

        if (!text || text.length > 2500 || seen.has(text)) continue;
        seen.add(text);
        items.push(text);
        messages.push({
          text,
          outbound: false,
          accessibility: null
        });

        if (messages.length >= 120) break;
      }
    }

    return {
      url: location.href,
      title: document.title,
      items,
      messages
    };
  });
}

async function sendBrowserMessage(threadUrl, rawText) {
  await requireAuthenticatedSession();

  const text = String(rawText || '');
  if (!text.trim()) {
    const error = new Error('message_text_required');
    error.status = 400;
    throw error;
  }
  if (text.length > 5000) {
    const error = new Error('message_too_long');
    error.status = 400;
    throw error;
  }

  if (threadUrl) {
    await navigateFacebook(threadUrl);
  } else if (!/\/messages\/t\//i.test(page.url())) {
    const error = new Error('thread_url_required');
    error.status = 400;
    throw error;
  }

  const selector =
    '[contenteditable="true"][role="textbox"],' +
    '[contenteditable="true"][data-lexical-editor="true"]';

  await page.waitForFunction(
    selector => {
      const nodes = [...document.querySelectorAll(selector)];
      return nodes.some(node => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none'
        );
      });
    },
    { timeout: 20_000 },
    selector
  );

  const focused = await page.evaluate(selector => {
    const visible = node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    };

    const candidates = [...document.querySelectorAll(selector)].filter(visible);
    const preferred = candidates.find(node => {
      const label = String(
        node.getAttribute('aria-label') ||
        node.getAttribute('data-placeholder') ||
        ''
      ).toLowerCase();

      return (
        /message|envoyer|écrire|write|mensaje|nachricht|messaggio|mensagem|type/.test(label) ||
        Boolean(node.closest('[role="main"]'))
      );
    });

    const composer = preferred || candidates[candidates.length - 1];
    if (!composer) return false;
    composer.focus();
    return true;
  }, selector);

  if (!focused) {
    const error = new Error('message_composer_not_found');
    error.status = 503;
    throw error;
  }

  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.type(text, { delay: 15 });
  await new Promise(resolve => setTimeout(resolve, 250));

  const clicked = await page.evaluate(() => {
    const visible = node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    };

    const patterns = [
      'send',
      'envoyer',
      'enviar',
      'senden',
      'invia',
      'enviar mensagem'
    ];

    const nodes = document.querySelectorAll(
      'button[aria-label], div[role="button"][aria-label]'
    );

    const button = [...nodes].find(node => {
      if (!visible(node)) return false;
      const label = String(node.getAttribute('aria-label') || '').toLowerCase();
      return patterns.some(pattern => label === pattern || label.includes(pattern));
    });

    if (!button) return false;
    button.click();
    return true;
  });

  if (!clicked) {
    await page.keyboard.press('Enter');
  }

  await new Promise(resolve => setTimeout(resolve, 700));

  return {
    sent: true,
    url: page.url(),
    usedButton: clicked,
    textLength: text.length
  };
}

export async function executePersistentSessionCommand({
  type,
  payload = {}
} = {}) {
  const command = String(type || '').trim().toLowerCase();
  const data =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : {};

  if (command === 'ping') {
    return {
      pong: true,
      status: await persistentSessionStatus()
    };
  }

  if (command === 'get_context') {
    return browserPageContext();
  }

  if (command === 'open_url') {
    const context = await requireAuthenticatedSession();
    const targetUrl = String(data.url || '');
    const next = await navigateFacebook(targetUrl);
    return {
      opened: true,
      previousUrl: context.url,
      context: next
    };
  }

  if (command === 'list_conversations') {
    return listBrowserConversations();
  }

  if (command === 'read_conversation') {
    return readBrowserConversation(
      String(data.threadUrl || data.url || '')
    );
  }

  if (command === 'send_message') {
    return sendBrowserMessage(
      String(data.threadUrl || data.url || ''),
      data.text
    );
  }

  const error = new Error('unsupported_persistent_session_command');
  error.status = 400;
  throw error;
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


    if (pathname === '/nexmeta/session/command') {
      if (req.method !== 'POST') {
        return writeJson(res, 405, { error: 'method_not_allowed' });
      }

      if (!sessionControlAuthorized(req)) {
        return writeJson(res, 401, { error: 'unauthorized' });
      }

      const body = await readJson(req, 64_000);
      const result = await executePersistentSessionCommand({
        type: body.type,
        payload: body.payload
      });

      return writeJson(res, 200, {
        ok: true,
        result
      });
    }

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

    if (pathname.startsWith('/nexmeta/session/captcha/')) {
      if (!setupAuthorized(pathname)) {
        res.statusCode = 410;
        securityHeaders(res);
        return res.end();
      }

      if (!page || page.isClosed()) {
        return writeJson(res, 503, { error: 'browser_not_ready' });
      }

      const clip = await captchaClipBox();
      if (!clip) {
        res.statusCode = 204;
        securityHeaders(res);
        return res.end();
      }

      const shot = await page.screenshot({
        type: 'png',
        clip
      });

      res.statusCode = 200;
      securityHeaders(res);
      res.setHeader('content-type', 'image/png');
      res.setHeader('x-nexmeta-captcha-width', String(clip.width));
      res.setHeader('x-nexmeta-captcha-height', String(clip.height));
      return res.end(shot);
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
        type: 'png'
      });

      res.statusCode = 200;
      securityHeaders(res);
      res.setHeader('content-type', 'image/png');
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

      if (action === 'focus') {
        const field = String(body.field || '');
        const selector =
          field === 'email'
            ? 'input[name="email"],input[type="email"],input[id*="email"]'
            : field === 'password'
              ? 'input[name="pass"],input[type="password"]'
              : '';

        if (!selector) {
          return writeJson(res, 400, { error: 'unsupported_field' });
        }

        const found = await page.evaluate(selector => {
          const node = document.querySelector(selector);
          if (!node) return false;
          node.focus();
          if (typeof node.select === 'function') node.select();
          return true;
        }, selector);

        if (!found) {
          return writeJson(res, 409, { error: 'field_not_found' });
        }
      } else if (action === 'submit_login') {
        const clicked = await page.evaluate(() => {
          const candidates = [
            ...document.querySelectorAll('button, input[type="submit"], div[role="button"]')
          ];
          const target = candidates.find(node => {
            const text = String(
              node.innerText ||
              node.value ||
              node.getAttribute('aria-label') ||
              ''
            ).trim().toLowerCase();
            return [
              'se connecter',
              'connexion',
              'log in',
              'login',
              'bejelentkezés'
            ].some(label => text === label || text.includes(label));
          });
          if (!target) return false;
          target.click();
          return true;
        });

        if (!clicked) {
          await page.keyboard.press('Enter');
        }
      } else if (action === 'force_french') {
        await page.setCookie({
          name: 'locale',
          value: 'fr_FR',
          domain: '.facebook.com',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'Lax'
        }).catch(() => {});
        await page.goto('https://www.facebook.com/?locale=fr_FR', {
          waitUntil: 'domcontentloaded',
          timeout: 60_000
        }).catch(() => {});
      } else if (action === 'click') {
        const x = Number(body.x);
        const y = Number(body.y);

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return writeJson(res, 400, { error: 'invalid_coordinates' });
        }

        await page.mouse.click(x, y);
      } else if (action === 'captcha_click') {
        const x = Number(body.x);
        const y = Number(body.y);
        const clip = await captchaClipBox();

        if (
          !clip ||
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          x < 0 ||
          y < 0 ||
          x > clip.width ||
          y > clip.height
        ) {
          return writeJson(res, 400, { error: 'invalid_captcha_coordinates' });
        }

        await page.mouse.click(clip.x + x, clip.y + y);
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
