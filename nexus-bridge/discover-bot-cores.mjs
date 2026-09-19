import {
  readdir,
  readFile,
  writeFile,
  stat
} from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.env.NEXUS_BOTS_ROOT || '/app/bots';
const OUTPUT =
  process.env.NEXUS_BRIDGE_DISCOVERY_FILE ||
  '/app/nexus-bridge/discovery.json';

const BOT_NAMES = [
  'nexgame',
  'nexcanal',
  'nexdownloader',
  'nexgroup',
  'nexstick'
];

const interestingName =
  /(core|service|handler|router|command|controller|manager|engine|index|main|app|server)/i;

const sourceExtension = /.(?:mjs|cjs|js|ts)$/i;

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory, {
  depth = 0,
  maxDepth = 5,
  files = [],
  maxFiles = 2000
} = {}) {
  if (depth > maxDepth || files.length >= maxFiles) return files;

  let entries = [];

  try {
    entries = await readdir(directory, {
      withFileTypes: true
    });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (files.length >= maxFiles) break;

    if (
      entry.name === 'node_modules' ||
      entry.name.startsWith('.') ||
      entry.name === 'coverage'
    ) {
      continue;
    }

    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await walk(full, {
        depth: depth + 1,
        maxDepth,
        files,
        maxFiles
      });
      continue;
    }

    if (!sourceExtension.test(entry.name)) continue;

    files.push(full);
  }

  return files;
}

function extractExports(source) {
  const names = new Set();

  for (const match of source.matchAll(
    /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g
  )) {
    names.add(match[1]);
  }

  for (const match of source.matchAll(
    /exports\.([A-Za-z_$][\w$]*)\s*=/g
  )) {
    names.add(match[1]);
  }

  for (const match of source.matchAll(
    /module\.exports\s*=\s*\{([^}]+)\}/g
  )) {
    for (const name of match[1].split(',')) {
      const clean = name
        .trim()
        .split(':')[0]
        .trim();

      if (/^[A-Za-z_$][\w$]*$/.test(clean)) {
        names.add(clean);
      }
    }
  }

  if (/export\s+default\s+/m.test(source)) {
    names.add('default');
  }

  return [...names].sort();
}

async function readPackage(botDir) {
  const file = path.join(botDir, 'package.json');

  try {
    const data = JSON.parse(await readFile(file, 'utf8'));

    return {
      name: data.name || null,
      version: data.version || null,
      type: data.type || null,
      main: data.main || null,
      module: data.module || null,
      exports: data.exports || null,
      scripts: data.scripts || null
    };
  } catch {
    return null;
  }
}

async function inspectBot(name) {
  const botDir = path.join(ROOT, name);
  const present = await exists(botDir);

  if (!present) {
    return {
      name,
      present: false,
      package: null,
      candidates: []
    };
  }

  const files = await walk(botDir);
  const candidates = [];

  for (const full of files) {
    const relative = path.relative(botDir, full);

    if (!interestingName.test(path.basename(full))) {
      continue;
    }

    let source = '';

    try {
      source = await readFile(full, 'utf8');
    } catch {
      continue;
    }

    const exports = extractExports(source);

    const signals = [
      /handle/i.test(source) ? 'handle' : null,
      /sendMessage|reply|answer/i.test(source) ? 'messaging' : null,
      /download/i.test(source) ? 'download' : null,
      /game|quiz/i.test(source) ? 'game' : null,
      /sticker|emoji/i.test(source) ? 'sticker' : null,
      /moder|admin|group/i.test(source) ? 'group' : null,
      /channel|publish|post/i.test(source) ? 'channel' : null
    ].filter(Boolean);

    candidates.push({
      path: relative,
      exports,
      signals
    });
  }

  candidates.sort((a, b) => {
    const score = item =>
      item.exports.length * 3 +
      item.signals.length * 2 -
      item.path.split(path.sep).length;

    return score(b) - score(a);
  });

  return {
    name,
    present: true,
    package: await readPackage(botDir),
    scannedFiles: files.length,
    candidates: candidates.slice(0, 80)
  };
}

const bots = [];

for (const name of BOT_NAMES) {
  bots.push(await inspectBot(name));
}

const report = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  bots
};

await writeFile(
  OUTPUT,
  JSON.stringify(report, null, 2),
  'utf8'
);

const summary = bots.map(bot => ({
  bot: bot.name,
  present: bot.present,
  package: bot.package?.name || null,
  candidates: bot.candidates?.length || 0,
  top: (bot.candidates || []).slice(0, 5).map(item => ({
    path: item.path,
    exports: item.exports.slice(0, 10),
    signals: item.signals
  }))
}));

console.log(
  '[nexus-bridge] bot-core discovery',
  JSON.stringify(summary)
);
