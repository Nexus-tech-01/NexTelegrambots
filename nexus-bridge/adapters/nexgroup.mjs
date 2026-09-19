import {
  liveModule,
  eventText,
  stripCommand,
  actorId,
  privilegedIds,
  languageOf
} from './_shared.mjs';

const token = String(
  process.env.NEXGROUP__BOT_TOKEN ||
  process.env.NEXGROUP_BOT_TOKEN ||
  process.env.NEXGROUP_TOKEN ||
  ''
).trim();
const mongoUri = String(process.env.NEXUS_MONGODB_URI || process.env.MONGODB_URI || '').trim();
const mongoDbName = String(process.env.NEXUS_MONGODB_DB_NAME || process.env.MONGODB_DB_NAME || 'nexus').trim();

if (!token) throw new Error('nexgroup_bot_token_missing');
if (!mongoUri) throw new Error('nexgroup_mongodb_missing');

const [{ MongoDb }, { NexGroupStore }, { TelegramBotApi }, { ModerationService }] = await Promise.all([
  import(liveModule('bots','nexgroup','dist','infrastructure','storage','mongo.js')),
  import(liveModule('bots','nexgroup','dist','infrastructure','storage','store.js')),
  import(liveModule('bots','nexgroup','dist','infrastructure','telegram','bot-api.js')),
  import(liveModule('bots','nexgroup','dist','domain','moderation','service.js'))
]);

const db = new MongoDb(mongoUri, mongoDbName, 'nexgroup_');
await db.connect();
const store = new NexGroupStore(db);
const api = new TelegramBotApi(token, Number(process.env.NEXGROUP__TELEGRAM_REQUEST_TIMEOUT_MS || 15000));
const moderation = new ModerationService(api, store);

export const adapterManifest = Object.freeze({
  version: '1.0.0',
  mode: 'live-core',
  productionReady: true,
  capabilities: ['managed_groups','ban','unban','kick','mute','unmute','warn'],
  core: 'NexGroup ModerationService + NexGroupStore'
});

function numericActor(envelope) {
  const raw = actorId(envelope);
  if (!/^-?\d+$/.test(raw)) {
    const e = new Error(raw ? 'linked_nexus_identity_is_not_a_telegram_id' : 'identity_link_required');
    e.status = 403;
    throw e;
  }
  return Number(raw);
}

async function actorContext(envelope, group) {
  const telegramId = numericActor(envelope);
  const user = await store.getUserByTelegramId(telegramId);
  const isOwner = privilegedIds().has(String(telegramId));
  if (isOwner) return { telegramId, user, role: 'OWNER' };
  if (!user) {
    const e = new Error('nexgroup_user_not_registered');
    e.status = 403;
    throw e;
  }
  const access = await store.getGroupAccess(group.id, user.id);
  const allowed = access && (
    access.kind === 'OWNER' ||
    access.permissions?.all === true ||
    access.permissions?.moderation === true
  );
  if (!allowed) {
    const e = new Error('nexgroup_permission_denied');
    e.status = 403;
    throw e;
  }
  return { telegramId, user, role: String(access.kind || 'MODERATOR') };
}

async function getGroup(chatId) {
  if (!/^-?\d+$/.test(String(chatId || ''))) {
    const e = new Error('group_chat_id_required');
    e.status = 400;
    throw e;
  }
  const group = await store.getGroupByChatId(String(chatId));
  if (!group || group.status !== 'ACTIVE') {
    const e = new Error('group_not_managed_by_nexgroup');
    e.status = 404;
    throw e;
  }
  return group;
}

function resultReply(action, result, lang) {
  if (!result?.ok) {
    return { text: (lang === 'fr' ? 'Action refusée: ' : 'Action failed: ') + String(result?.detail || result?.error || 'unknown_error') };
  }
  const suffix = result.auditId ? ' · audit ' + result.auditId : '';
  return { text: (lang === 'fr' ? 'NexGroup: ' : 'NexGroup: ') + action + ' OK' + suffix };
}

export async function handle(envelope) {
  const text = eventText(envelope);
  const lang = languageOf(envelope);
  const args = stripCommand(text);
  const action = String(args.shift() || 'list').toLowerCase();
  const actorTelegramId = numericActor(envelope);

  if (['list','liste','groups','groupes'].includes(action)) {
    const user = await store.getUserByTelegramId(actorTelegramId);
    if (!user && !privilegedIds().has(String(actorTelegramId))) {
      return { text: lang === 'fr' ? 'Ton identité liée n’existe pas encore dans NexGroup.' : 'Your linked identity is not registered in NexGroup yet.' };
    }
    const groups = user
      ? await store.listManagedGroups(user.id)
      : await store.listActiveGroups(25);
    return {
      text: groups.length
        ? groups.slice(0,25).map(g => g.title + ' — ' + g.telegram_chat_id).join('\n')
        : (lang === 'fr' ? 'Aucun groupe géré.' : 'No managed group.')
    };
  }

  const chatId = args.shift();
  const targetRaw = args.shift();
  const group = await getGroup(chatId);
  const actor = await actorContext(envelope, group);

  if (!/^-?\d+$/.test(String(targetRaw || ''))) {
    const e = new Error('target_telegram_user_id_required');
    e.status = 400;
    throw e;
  }
  const targetUserId = Number(targetRaw);
  const updateId = Number(envelope?.event?.timestamp || Date.now());
  const reason = args.join(' ').trim() || 'NexMeta Facebook command';
  const common = { group, targetUserId, actorTelegramId: actor.telegramId, actorRole: actor.role, reason, updateId };

  if (action === 'ban') return resultReply('ban', await moderation.ban(common), lang);
  if (action === 'unban') return resultReply('unban', await moderation.unban(common), lang);
  if (action === 'kick') return resultReply('kick', await moderation.kick(common), lang);
  if (action === 'unmute') {
    return resultReply('unmute', await moderation.unmute({ ...common, source:'COMMAND' }), lang);
  }
  if (action === 'mute') {
    const secondsRaw = args.shift();
    const seconds = Math.max(30, Math.min(30 * 86400, Number(secondsRaw || 3600)));
    return resultReply('mute', await moderation.mute({ ...common, seconds, source:'COMMAND' }), lang);
  }
  if (action === 'warn') {
    const { config } = await store.getConfig(group.id);
    return resultReply('warn', await moderation.warn({ ...common, config }), lang);
  }

  return {
    text: lang === 'fr'
      ? 'Commandes: /group list | /group ban <chatId> <userId> [raison] | unban | kick | mute | unmute | warn'
      : 'Commands: /group list | /group ban <chatId> <userId> [reason] | unban | kick | mute | unmute | warn'
  };
}

export default handle;
