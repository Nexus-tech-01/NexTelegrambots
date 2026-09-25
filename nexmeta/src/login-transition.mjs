import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';

const execFileAsync = promisify(execFile);

const browserUrl = String(
  process.env.NEXMETA_INTERACTIVE_BROWSER_URL ||
  'http://127.0.0.1:9223'
);

const pollMs = Math.max(
  2000,
  Math.min(
    30_000,
    Number(process.env.NEXMETA_LOGIN_TRANSITION_POLL_MS || 5000)
  )
);

const persistentHealthUrl = String(
  process.env.NEXMETA_PERSISTENT_HEALTH_URL ||
  'http://127.0.0.1:8788/nexmeta/session/health'
);

const interactiveServices = [
  'nexmeta-interactive-tunnel.service',
  'nexmeta-session-tunnel.service',
  'nexmeta-interactive-proxy.service',
  'nexmeta-interactive-novnc.service',
  'nexmeta-interactive-vnc.service',
  'nexmeta-interactive-browser.service',
  'nexmeta-interactive-xvfb.service'
];

const targetServices = [
  'nexmeta-session.service'
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function systemctl(action, service) {
  await execFileAsync(
    '/usr/bin/systemctl',
    [action, service],
    { timeout: 30_000 }
  );
}

async function interactiveLoggedIn() {
  let browser;

  try {
    browser = await puppeteer.connect({
      browserURL: browserUrl
    });

    const pages = await browser.pages();
    const page =
      pages.find(item => /facebook\.com/i.test(item.url())) ||
      pages[0];

    if (!page) return false;

    const currentUrl = String(page.url() || '').toLowerCase();
    if (
      currentUrl.includes('/login') ||
      currentUrl.includes('/checkpoint') ||
      currentUrl.includes('/recover') ||
      currentUrl.includes('/two_step_verification/')
    ) {
      return false;
    }

    const cookies = await page.cookies(
      'https://www.facebook.com/'
    );

    const cUser = cookies.find(
      cookie =>
        cookie.name === 'c_user' &&
        String(cookie.value || '').trim()
    );

    if (!cUser) return false;

    return await page.evaluate(() => {
      const loginForm = document.querySelector(
        'input[name="email"],input[name="pass"],form[action*="login"]'
      );

      return !loginForm;
    });
  } catch {
    return false;
  } finally {
    if (browser) {
      await browser.disconnect().catch(() => {});
    }
  }
}

async function persistentReady() {
  try {
    const response = await fetch(
      persistentHealthUrl,
      {
        signal: AbortSignal.timeout(5000)
      }
    );

    if (!response.ok) return false;

    const body = await response.json();
    return body?.loggedIn === true;
  } catch {
    return false;
  }
}

async function transition() {
  console.log(
    '[NexMeta Transition] authenticated Facebook session detected'
  );

  await sleep(4000);

  for (const service of interactiveServices) {
    await systemctl('stop', service).catch(() => {});
  }

  await sleep(1500);

  for (const service of targetServices) {
    await systemctl('restart', service);
  }

  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    if (await persistentReady()) {
      console.log(
        '[NexMeta Transition] persistent Facebook runtime is authenticated'
      );
      return true;
    }

    await sleep(3000);
  }

  throw new Error(
    'persistent_runtime_did_not_recover_authenticated_session'
  );
}

async function main() {
  console.log(
    '[NexMeta Transition] waiting for Facebook authentication'
  );

  while (true) {
    if (await interactiveLoggedIn()) {
      await transition();
      return;
    }

    await sleep(pollMs);
  }
}

main().catch(error => {
  console.error(
    '[NexMeta Transition] failed',
    String(error?.message || error)
  );
  process.exitCode = 1;
});
