import puppeteer from 'puppeteer-core';

const DEFAULT_PAGE_ID = '106458282029367';
const DEFAULT_BUSINESS_ID = '400407402634452';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function clean(value) {
  return String(value ?? '').trim();
}

function csv(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function allowedPageId() {
  return clean(
    process.env.NEXMETA_INTERNAL_PUBLISH_PAGE_ID ||
    DEFAULT_PAGE_ID
  );
}

function allowedBusinessId() {
  return clean(
    process.env.NEXMETA_INTERNAL_PUBLISH_BUSINESS_ID ||
    DEFAULT_BUSINESS_ID
  );
}

function allowedSources() {
  const configured = csv(
    process.env.NEXMETA_INTERNAL_PUBLISH_SOURCES
  );

  return new Set(
    configured.length
      ? configured
      : [
          'nexcanal',
          'nexnews',
          'nextech',
          'nexcontrol',
          'system'
        ]
  );
}

function browserDebugUrl() {
  return clean(
    process.env.NEXMETA_BROWSER_DEBUG_URL ||
    'http://127.0.0.1:9223'
  );
}

function contentPageUrl(pageId = allowedPageId()) {
  const params = new URLSearchParams({
    business_id: allowedBusinessId(),
    asset_id: pageId
  });

  return (
    'https://business.facebook.com/latest/posts/published_posts/?' +
    params.toString()
  );
}

function composerUrl(pageId = allowedPageId()) {
  const params = new URLSearchParams({
    asset_id: pageId,
    business_id: allowedBusinessId(),
    nav_ref: 'internal_nav',
    ref: 'biz_web_content_manager_published_posts',
    context_ref: 'POSTS'
  });

  return (
    'https://business.facebook.com/latest/composer/?' +
    params.toString()
  );
}

function isUnsafeFile(value) {
  return /\.(?:apk|xapk|apks|aab|exe|msi|dmg|pkg|zip|rar|7z)(?:$|[?#])/i
    .test(String(value || ''));
}

export function assertInternalPublicationPolicy({
  pageId,
  source = 'system',
  mediaUrl,
  fileName
} = {}) {
  const target = clean(pageId || allowedPageId());
  const allowedTarget = allowedPageId();

  if (!allowedTarget || target !== allowedTarget) {
    const error = new Error('facebook_page_not_authorized');
    error.status = 403;
    throw error;
  }

  const normalizedSource = clean(source || 'system').toLowerCase();

  if (!allowedSources().has(normalizedSource)) {
    const error = new Error('facebook_publication_source_not_authorized');
    error.status = 403;
    throw error;
  }

  if (isUnsafeFile(mediaUrl) || isUnsafeFile(fileName)) {
    const error = new Error('facebook_incompatible_file');
    error.status = 422;
    throw error;
  }

  return {
    pageId: target,
    source: normalizedSource
  };
}

export function normalizeFacebookPublication({
  message = '',
  link,
  buttons
} = {}) {
  const parts = [];

  const text = clean(message);
  if (text) parts.push(text);

  if (Array.isArray(buttons)) {
    for (const button of buttons.slice(0, 12)) {
      const label = clean(button?.text || button?.label || button?.title);
      const url = clean(button?.url);

      if (!url) continue;
      parts.push(label ? `${label} — ${url}` : url);
    }
  }

  const normalizedLink = clean(link);
  if (normalizedLink && !parts.some(part => part.includes(normalizedLink))) {
    parts.push(normalizedLink);
  }

  const body = parts.join('\n\n').trim();

  if (!body) {
    throw new Error('facebook_publication_empty');
  }

  return {
    message: body,
    link: normalizedLink || null
  };
}

async function connectBrowser() {
  return puppeteer.connect({
    browserURL: browserDebugUrl(),
    defaultViewport: null
  });
}

async function facebookLoggedIn(page) {
  const cookies = await page.cookies('https://www.facebook.com/');

  return cookies.some(
    cookie =>
      cookie.name === 'c_user' &&
      String(cookie.value || '').trim()
  );
}

async function findComposer(page) {
  const selectors = [
    '[role="combobox"][aria-label*="ajouter du texte"]',
    '[role="combobox"][aria-label*="add text"]',
    '[contenteditable="true"][role="combobox"]',
    '[contenteditable="true"][role="textbox"]'
  ];

  for (const selector of selectors) {
    const handles = await page.$$(selector);

    for (const handle of handles) {
      const box = await handle.boundingBox().catch(() => null);
      if (box && box.width > 180 && box.height > 20) {
        return handle;
      }
    }
  }

  return null;
}

async function buttonByText(page, patterns) {
  const handles = await page.$$(
    'button,[role="button"]'
  );

  for (const handle of handles) {
    const data = await handle
      .evaluate(element => ({
        text: String(
          element.innerText ||
          element.getAttribute('aria-label') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim(),
        disabled:
          element.disabled === true ||
          element.getAttribute('aria-disabled') === 'true'
      }))
      .catch(() => null);

    if (!data || data.disabled || !data.text) continue;

    if (patterns.some(pattern => pattern.test(data.text))) {
      const box = await handle.boundingBox().catch(() => null);
      if (box) return handle;
    }
  }

  return null;
}

async function waitForComposer(page, timeoutMs = 20000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const composer = await findComposer(page);
    if (composer) return composer;
    await sleep(400);
  }

  throw new Error('facebook_composer_not_found');
}

async function waitForPublishButton(page, timeoutMs = 12000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const button = await buttonByText(page, [
      /^Publier$/i,
      /^Publish$/i
    ]);

    if (button) return button;
    await sleep(350);
  }

  throw new Error('facebook_publish_button_not_found');
}

export async function probeBrowserPagePublisher({
  pageId,
  source = 'system'
} = {}) {
  const policy = assertInternalPublicationPolicy({
    pageId,
    source
  });

  const browser = await connectBrowser();
  const page = await browser.newPage();

  try {
    await page.goto(composerUrl(policy.pageId), {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    if (!await facebookLoggedIn(page)) {
      throw new Error('facebook_session_not_authenticated');
    }

    const composer = await waitForComposer(page, 25000);
    const publishButton = await waitForPublishButton(page, 15000);

    if (!composer || !publishButton) {
      throw new Error('facebook_publish_permission_not_visible');
    }

    return {
      ok: true,
      authorized: true,
      pageId: policy.pageId,
      source: policy.source,
      transport: 'business_suite_browser'
    };
  } finally {
    await page.close().catch(() => {});
    await browser.disconnect().catch(() => {});
  }
}

export async function publishBrowserPagePost({
  message = '',
  link,
  buttons,
  pageId,
  source = 'system',
  mediaUrl,
  fileName,
  dryRun = false
} = {}) {
  const policy = assertInternalPublicationPolicy({
    pageId,
    source,
    mediaUrl,
    fileName
  });

  const publication = normalizeFacebookPublication({
    message,
    link,
    buttons
  });

  const browser = await connectBrowser();
  const page = await browser.newPage();

  try {
    await page.goto(composerUrl(policy.pageId), {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    if (!await facebookLoggedIn(page)) {
      throw new Error('facebook_session_not_authenticated');
    }

    const composer = await waitForComposer(page);

    await composer.focus();

    await page.keyboard.insertText(publication.message);

    await sleep(700);

    const publishButton = await waitForPublishButton(page);

    if (dryRun) {
      return {
        ok: true,
        authorized: true,
        dryRun: true,
        pageId: policy.pageId,
        source: policy.source,
        transport: 'business_suite_browser',
        textLength: publication.message.length
      };
    }

    await publishButton.click();

    const started = Date.now();
    let published = false;

    while (Date.now() - started < 30000) {
      const current = String(page.url() || '');

      if (
        !current.includes('/composer/') ||
        await page
          .evaluate(() => {
            const text = String(document.body?.innerText || '');
            return /(?:publication publiée|post published|publié)/i.test(text);
          })
          .catch(() => false)
      ) {
        published = true;
        break;
      }

      await sleep(700);
    }

    if (!published) {
      throw new Error('facebook_publish_confirmation_timeout');
    }

    return {
      ok: true,
      published: true,
      pageId: policy.pageId,
      source: policy.source,
      transport: 'business_suite_browser',
      textLength: publication.message.length
    };
  } finally {
    await page.close().catch(() => {});
    await browser.disconnect().catch(() => {});
  }
}
