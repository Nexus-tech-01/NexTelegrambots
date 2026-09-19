import {
  liveModule,
  eventText,
  externalUserId,
  languageOf,
  stripCommand,
  renderCoreOutput
} from './_shared.mjs';

const [{ gamesById, playableGames }, runtime] = await Promise.all([
  import(liveModule('bots','nexgame','dist','src','games','catalog','game-catalog.js')),
  import(liveModule('bots','nexgame','dist','src','games','core','runtime.js'))
]);

const { initializeGame, renderGame, handleGameText, handleGameCallback } = runtime;
const sessions = new Map();
const SESSION_TTL_MS = 45 * 60 * 1000;

export const adapterManifest = Object.freeze({
  version: '1.0.0',
  mode: 'live-core',
  productionReady: true,
  capabilities: ['solo_game_catalog','solo_game_start','game_text_turns','game_callbacks'],
  core: 'NexGame dist/src/games/core/runtime.js'
});

function key(envelope) {
  return String(envelope?.source?.pageId || '') + ':' + externalUserId(envelope);
}

function sweep() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [k, value] of sessions) {
    if (value.touchedAt < cutoff) sessions.delete(k);
  }
}

function getSession(envelope) {
  sweep();
  const row = sessions.get(key(envelope));
  if (row) row.touchedAt = Date.now();
  return row || null;
}

export function hasActiveSession(envelope) {
  const row = getSession(envelope);
  return Boolean(row && row.session?.status !== 'FINISHED');
}

function gameList(language='fr') {
  const games = playableGames('solo').filter(g => (g.status || 'READY') === 'READY').slice(0, 8);
  return {
    text: language === 'fr'
      ? 'Jeux NexGame disponibles sur Facebook :\n' + games.map(g => '• ' + g.name + ' — /game ' + g.id).join('\n')
      : 'NexGame titles available on Facebook:\n' + games.map(g => '• ' + g.name + ' — /game ' + g.id).join('\n'),
    quickReplies: games.slice(0, 6).map(g => ({ title: g.name.slice(0,20), payload: '/game ' + g.id }))
  };
}

function startGame(envelope, id) {
  const lang = languageOf(envelope);
  const def = gamesById.get(id);
  if (!def || !def.solo || (def.status || 'READY') !== 'READY') {
    return gameList(lang);
  }

  const userId = externalUserId(envelope) || 'facebook-player';
  const session = {
    id: 'fb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8),
    gameId: def.id,
    status: 'ACTIVE',
    players: [{ userId, displayName: 'Facebook Player', status: 'ACTIVE' }],
    state: { language: lang },
    createdAt: new Date(),
    updatedAt: new Date()
  };

  initializeGame(session, def);
  sessions.set(key(envelope), { session, def, touchedAt: Date.now() });

  const reply = renderCoreOutput(renderGame(session, def));
  reply.text = (lang === 'fr' ? def.name + '\n\n' : def.name + '\n\n') + reply.text;
  return reply;
}

function stopGame(envelope) {
  sessions.delete(key(envelope));
  return { text: languageOf(envelope) === 'fr' ? 'Partie NexGame arrêtée.' : 'NexGame session stopped.' };
}

export async function handle(envelope) {
  const text = eventText(envelope);
  const lang = languageOf(envelope);
  const args = stripCommand(text);
  const first = String(args[0] || '').toLowerCase();

  if (/^\/?(?:game|play|quiz|jeu|jouer)\b/i.test(text)) {
    if (!first || first === 'list' || first === 'liste') return gameList(lang);
    if (first === 'stop' || first === 'quit' || first === 'quitter') return stopGame(envelope);
    return startGame(envelope, first);
  }

  const row = getSession(envelope);
  if (!row) return gameList(lang);
  if (row.session.status === 'FINISHED') {
    sessions.delete(key(envelope));
    return { text: lang === 'fr' ? 'La partie est terminée. Envoie /game pour en lancer une autre.' : 'The game is over. Send /game to start another one.' };
  }

  const userId = externalUserId(envelope) || 'facebook-player';
  const payload = String(envelope?.event?.payload || '').trim();

  if (payload && !text) {
    await handleGameCallback(row.session, row.def, userId, payload, undefined, {
      receivedAt: Number(envelope?.event?.timestamp || Date.now())
    });
  } else {
    await handleGameText(row.session, row.def, userId, text, {
      receivedAt: Number(envelope?.event?.timestamp || Date.now())
    });
  }

  row.session.updatedAt = new Date();
  row.touchedAt = Date.now();
  const reply = renderCoreOutput(renderGame(row.session, row.def));
  if (row.session.status === 'FINISHED') sessions.delete(key(envelope));
  return reply;
}

export default handle;
