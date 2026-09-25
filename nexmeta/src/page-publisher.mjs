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

async function dismissBusinessSuiteOverlays(page) {
  for (let round = 0; round < 10; round += 1) {
    const clicked = await page.evaluate(() => {
      const cleanText = value =>
        String(value || '').replace(/\s+/g, ' ').trim();

      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);

        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      };

      const pattern =
        /^(Terminé|Fermer|OK|Done|Close|Compris|Got it)$/i;

      const item = [
        ...document.querySelectorAll(
          'button,[role="button"]'
        )
      ]
        .filter(visible)
        .find(element =>
          pattern.test(
            cleanText(
              element.innerText ||
              element.getAttribute('aria-label') ||
              ''
            )
          )
        );

      if (!item) return false;
      item.click();
      return true;
    }).catch(() => false);

    if (!clicked && round > 2) break;
    await sleep(clicked ? 350 : 120);
  }
}

async function openBusinessComposer(browser, pageId) {
  const before = await browser.pages();
  const launcher = await browser.newPage();

  try {
    await launcher.goto(contentPageUrl(pageId), {
      waitUntil: 'domcontentloaded',
      timeout: 35000
    });

    await sleep(1200);
    await dismissBusinessSuiteOverlays(launcher);

    const buttonBox = await launcher.evaluate(() => {
      const cleanText = value =>
        String(value || '').replace(/\s+/g, ' ').trim();

      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);

        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      };

      const item = [
        ...document.querySelectorAll('[role="button"]')
      ]
        .filter(visible)
        .find(element =>
          /^(Créer une publication|Create post)$/i.test(
            cleanText(
              element.innerText ||
              element.getAttribute('aria-label') ||
              ''
            )
          )
        );

      if (!item) return null;

      const rect = item.getBoundingClientRect();

      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2
      };
    });

    if (!buttonBox) {
      throw new Error('facebook_create_post_button_not_found');
    }

    await launcher.mouse.click(buttonBox.x, buttonBox.y);

    const started = Date.now();

    while (Date.now() - started < 12000) {
      await sleep(250);

      const pages = await browser.pages();

      for (const candidate of pages) {
        const url = String(candidate.url() || '');

        if (
          !url.includes(
            'business.facebook.com/latest/composer/'
          ) ||
          !url.includes(
            'asset_id=' + encodeURIComponent(pageId)
          )
        ) {
          continue;
        }

        const ready = await candidate.evaluate(() => {
          const visible = element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);

            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden'
            );
          };

          const editor = [
            ...document.querySelectorAll(
              '[role="combobox"],[contenteditable="true"]'
            )
          ]
            .filter(visible)
            .find(element =>
              /ajouter du texte|add text/i.test(
                element.getAttribute('aria-label') || ''
              )
            );

          const publish = [
            ...document.querySelectorAll(
              'button,[role="button"]'
            )
          ]
            .filter(visible)
            .find(element =>
              /^(Publier|Publish)$/i.test(
                String(
                  element.innerText ||
                  element.getAttribute('aria-label') ||
                  ''
                )
                  .replace(/\s+/g, ' ')
                  .trim()
              )
            );

          return Boolean(editor && publish);
        }).catch(() => false);

        if (ready) {
          return {
            page: candidate,
            launcher:
              candidate === launcher ? null : launcher,
            existing: before.includes(candidate)
          };
        }
      }
    }

    throw new Error('facebook_composer_open_timeout');
  } catch (error) {
    await launcher.close().catch(() => {});
    throw error;
  }
}

async function facebookLoggedIn(page) {
  const cookies = await page.cookies('https://www.facebook.com/');

  return cookies.some(
    cookie =>
      cookie.name === 'c_user' &&
      String(cookie.value || '').trim()
  );
}

async function focusComposer(page) {
  return page.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };

    const candidates = [
      ...document.querySelectorAll(
        '[role="combobox"],[contenteditable="true"][role="textbox"]'
      )
    ].filter(visible);

    const editor =
      candidates.find(element =>
        /ajouter du texte|add text/i.test(
          element.getAttribute('aria-label') || ''
        )
      ) ||
      candidates.find(element =>
        element.getBoundingClientRect().width > 250
      );

    if (!editor) return false;

    editor.focus();
    return true;
  });
}

async function clearComposer(page) {
  const focused = await focusComposer(page);
  if (!focused) return false;

  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await sleep(200);

  return true;
}

async function discardComposer(page) {
  const cancel = await buttonByText(
    page,
    [/^Annuler$/i, /^Cancel$/i],
    { allowDisabled: false }
  );

  if (cancel) {
    await cancel.click().catch(() => {});
    await sleep(350);
  }

  const discard = await buttonByText(
    page,
    [
      /^Supprimer$/i,
      /^Ignorer$/i,
      /^Abandonner$/i,
      /^Discard$/i,
      /^Delete$/i
    ],
    { allowDisabled: false }
  );

  if (discard) {
    await discard.click().catch(() => {});
    await sleep(250);
  }
}

async function buttonByText(page, patterns, { allowDisabled = false } = {}) {
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

    if (!data || (!allowDisabled && data.disabled) || !data.text) continue;

    if (patterns.some(pattern => pattern.test(data.text))) {
      const box = await handle.boundingBox().catch(() => null);
      if (box) return handle;
    }
  }

  return null;
}

async function waitForComposer(page, timeoutMs = 15000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (await focusComposer(page).catch(() => false)) {
      return true;
    }
    await sleep(250);
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
  let page = null;
  let launcher = null;

  try {
    const opened = await openBusinessComposer(
      browser,
      policy.pageId
    );

    page = opened.page;
    launcher = opened.launcher;

    if (!await facebookLoggedIn(page)) {
      throw new Error('facebook_session_not_authenticated');
    }

    const composerReady = await waitForComposer(page, 15000);
    const publishButton = await buttonByText(
      page,
      [/^Publier$/i, /^Publish$/i],
      { allowDisabled: true }
    );

    if (!composerReady || !publishButton) {
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
    if (page) await page.close().catch(() => {});
    if (launcher && launcher !== page) {
      await launcher.close().catch(() => {});
    }
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
  let page = null;
  let launcher = null;

  try {
    const opened = await openBusinessComposer(
      browser,
      policy.pageId
    );

    page = opened.page;
    launcher = opened.launcher;

    if (!await facebookLoggedIn(page)) {
      throw new Error('facebook_session_not_authenticated');
    }

    await waitForComposer(page);
    await page.keyboard.insertText(publication.message);
    await sleep(700);

    if (dryRun) {
      const publishButton = await waitForPublishButton(
        page,
        7000
      );

      if (!publishButton) {
        throw new Error('facebook_publish_button_not_enabled');
      }

      await clearComposer(page).catch(() => false);
      await discardComposer(page).catch(() => {});

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

    const publishButton = await waitForPublishButton(page);
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
    if (page) await page.close().catch(() => {});
    if (launcher && launcher !== page) {
      await launcher.close().catch(() => {});
    }
    await browser.disconnect().catch(() => {});
  }
}
