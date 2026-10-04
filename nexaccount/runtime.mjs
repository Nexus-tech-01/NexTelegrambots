import crypto from 'node:crypto';
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { NewMessage } from 'teleproto/events/index.js';
import { getInputChannel, getInputUser } from 'teleproto/Utils.js';
import { returnBigInt } from 'teleproto/Helpers.js';
import { cfg, isOwnerId, isOwnerIdentity } from './config.mjs';
import { commandMap } from './commands.mjs';
import { accountAssignedToWorker, accountWithSession, acquireRuntimeLease, acquireSessionLease, claimCommandDelivery, db, disableAccount, enableAccount, listAccountsForWorker, markSessionRepairRequired, nexAiPremiumState, patchSettings, releaseRuntimeLease, releaseSessionLease, renewRuntimeLease, renewSessionLease, sessionFingerprint, settingsFor, sharedBotIdentity } from './store.mjs';
import { listStyles } from './styles.mjs';
import { creatorCaptionModel, creatorImagePath } from './creator.mjs';
import { recordEvent } from './analytics.mjs';
import { ownerPanelText, usersText, countriesText, languagesText, userText, botStatsText, activityText, growthText, commandStatsText } from './owner.mjs';
import { handleCompatCommand } from './compat.mjs';
import { menuModel, stylesModel } from './menu.mjs';
import { aiProviderStatus, generateAiReply } from './ai-engine.mjs';
import { stickerEngineDiagnostic, canHandleStickerCommand, resumeStickerJobs } from './sticker-engine.mjs';
import { parseCommand, textOf } from './core/command-parser.mjs';
import { createCommandDeduper } from './core/command-deduper.mjs';
import { createRuntimeContext, clearRuntimeTimers } from './core/runtime-context.mjs';
import { routeEngineCommand } from './core/engine-router.mjs';
import { animeBeginRebuild, animeDedupePublishedEpisodeVariants, animeDiscoverNow, animeIngestStatus, animePublishNow, handleAnimeIngestEvent, isListenerRuntime, startAnimeIngest, stopAnimeIngest } from './anime-ingest.mjs';
import { normalizeVideoNoteBuffer, sendTelegramMedia } from './media-send.mjs';
import { deleteStoredReplyVideo, downloadReplyVideo, replyStorageJoinLink, storeReplyVideo } from './reply-storage.mjs';
import { ensureEmojiLibraryPalette, ensurePremiumEmojiPalette, sanitizeAnimatedEmojiText, sendBrandedText, syncOwnedCustomEmojiLibrary } from './response-ui.mjs';
import { putInlineResponse } from './inline-response-store.mjs';
import { resolveBotUsername } from './secrets.mjs';
import { ensureNexAiBotPresentation } from './bot-factory.mjs';
import { handlePremiumPowerEvent, startPremiumPowers } from './premium-engine.mjs';

function replyHotCachePeer(configured={}){
  const channelId=String(configured?.hotCacheChannelId||'').trim();
  const accessHash=String(configured?.hotCacheAccessHash||'').trim();
  if(!channelId||!accessHash)return null;
  return new Api.InputChannel({
    channelId:returnBigInt(channelId),
    accessHash:returnBigInt(accessHash)
  });
}

function replyStorageChannelId(configured={}){
  const raw=String(configured?.storage?.chatId||'').trim();
  const botApi=raw.match(/^-100(\d+)$/);
  if(botApi)return botApi[1];
  return /^\d+$/.test(raw)?raw:'';
}

async function replyStorageHotCachePeer(client,configured={}){
  const channelId=replyStorageChannelId(configured);
  if(!channelId)return null;
  const peerChannel=new Api.PeerChannel({channelId:returnBigInt(channelId)});
  try{
    const peer=getInputChannel(await client.getInputEntity(peerChannel));
    if(peer?.channelId!=null&&peer?.accessHash!=null){
      return {
        peer,
        ref:{
          hotCacheChannelId:String(peer.channelId),
          hotCacheAccessHash:String(peer.accessHash),
          hotCacheSharedStorage:true
        }
      };
    }
  }catch{}
  try{
    const dialogs=await client.getDialogs({limit:200});
    const match=(Array.isArray(dialogs)?dialogs:[]).find(row=>
      String(row?.entity?.id||row?.id||'')===channelId
    );
    if(!match)return null;
    const peer=getInputChannel(await client.getInputEntity(match.entity||match));
    if(peer?.channelId==null||peer?.accessHash==null)return null;
    return {
      peer,
      ref:{
        hotCacheChannelId:String(peer.channelId),
        hotCacheAccessHash:String(peer.accessHash),
        hotCacheSharedStorage:true
      }
    };
  }catch{return null}
}

async function ensureReplyHotCacheChannel(client,configured={}){
  let fallback=await replyStorageHotCachePeer(client,configured);
  if(fallback)return fallback;

  try{
    const invite=await replyStorageJoinLink();
    const link=String(invite?.inviteLink||'');
    const hash=(link.match(/(?:\+|joinchat\/)([A-Za-z0-9_-]+)/)||[])[1]||'';
    if(!hash)throw new Error('lien NexAI Storage invalide');
    const joined=await client.invoke(new Api.messages.ImportChatInvite({hash}));
    const chat=(joined?.chats||[]).find(row=>row?.id!=null&&row?.accessHash!=null);
    if(chat){
      const peer=getInputChannel(chat);
      try{
        const inputPeer=new Api.InputPeerChannel({channelId:chat.id,accessHash:chat.accessHash});
        await client.invoke(new Api.folders.EditPeerFolders({
          folderPeers:[new Api.InputFolderPeer({peer:inputPeer,folderId:1})]
        }));
      }catch{}
      return {
        peer,
        ref:{
          hotCacheChannelId:String(chat.id),
          hotCacheAccessHash:String(chat.accessHash),
          hotCacheSharedStorage:true
        }
      };
    }
  }catch(joinError){
    const text=String(joinError?.errorMessage||joinError?.message||joinError||'');
    if(!/USER_ALREADY_PARTICIPANT/i.test(text)){
      console.warn('[NexAccount reply hot-cache join]',text.slice(0,220));
    }
  }

  fallback=await replyStorageHotCachePeer(client,configured);
  if(fallback)return fallback;
  throw new Error('NexAI Storage inaccessible pour cette session');
}

const commands=commandMap();
const runtimes=new Map();
const spamWindows=new Map();
const greetingEventsSeen=new Map();
const commandDeduper=createCommandDeduper();
const generatedCommandOutputs=new Map();
const aiAutoWindows=new Map();
let reconcilingRuntimes=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ANIME_PRIMARY_PUBLISHER_ENABLED=true;
const ANIME_PRIMARY_PUBLISHER_USERNAME=String(process.env.NEXACCOUNT_ANIME_PUBLISHER_USERNAME||'tresor20001').trim().replace(/^@/,'').toLowerCase();
const ANIME_PUBLISHER_FAILOVER_USERNAMES=[...new Set(
  String(process.env.NEXACCOUNT_ANIME_FAILOVER_USERNAMES||'tresor20009,tresor20000')
    .split(',').map(x=>x.trim().replace(/^@/,'').toLowerCase()).filter(Boolean)
)];
let animePublisherRuntimeId='';
let animePublisherElectionPromise=null;
const EMBEDDED_ANIME_ENABLED=!/^(?:0|false|no|off)$/i.test(String(process.env.NEXACCOUNT_EMBEDDED_ANIME||'true').trim());
const EMBEDDED_LITEAPK_ENABLED=!/^(?:0|false|no|off)$/i.test(String(process.env.NEXACCOUNT_EMBEDDED_LITEAPK||'true').trim());
const ANIME_WORKER_URL=String(process.env.NEXANIME_WORKER_URL||'http://127.0.0.1:18130').replace(/\/+$/,'');

async function animeWorkerRequest(pathname,payload=null){
  const url=ANIME_WORKER_URL+pathname;
  const options=payload===null
    ?{signal:AbortSignal.timeout(15_000)}
    :{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(120_000)};
  const response=await fetch(url,options);
  const text=await response.text();
  let data;
  try{data=JSON.parse(text)}catch{data={ok:false,error:text||('HTTP '+response.status)}}
  if(!response.ok||data?.ok===false)throw new Error(String(data?.error||('NexAnime worker HTTP '+response.status)));
  return data;
}

function telegramRuntimeErrorText(error){
  return String(error?.errorMessage||error?.message||error||'');
}

function isAuthKeyDuplicatedError(error){
  return /AUTH_KEY_DUPLICATED|AuthKeyDuplicatedError|Concurrent usage of the current session from multiple connections/i.test(telegramRuntimeErrorText(error));
}
function isAuthKeyUnregisteredError(error){
  return /AUTH_KEY_UNREGISTERED|AuthKeyUnregisteredError|authorization key is not registered|authorization is invalid/i.test(telegramRuntimeErrorText(error));
}
function isReconnectableTelegramTransportError(error){
  return /Cannot send requests while disconnected|authorization is invalid|AuthKeyUnregistered|AUTH_KEY_UNREGISTERED|watcher session is not authorized|not connected/i.test(telegramRuntimeErrorText(error));
}

async function quarantineInvalidAuthKey(runtime,error,source='runtime'){
  if(!runtime)return false;
  if(runtime.authKeyQuarantinePromise)return runtime.authKeyQuarantinePromise;
  const id=String(runtime.account?.telegramUserId||'');
  runtime.sessionInvalidated=true;
  runtime.sessionInvalidatedAt=new Date();
  runtime.sessionInvalidationReason='AUTH_KEY_UNREGISTERED';
  runtime.authKeyQuarantinePromise=(async()=>{
    console.error('[NexAccount session]',id,'AUTH_KEY_UNREGISTERED; saved session requires reconnect source='+source,telegramRuntimeErrorText(error).slice(0,240));
    clearRuntimeTimers(runtime);
    await stopEmbeddedLiteApkScanner(runtime).catch(()=>{});
    await stopAnimeIngest(runtime).catch(()=>{});
    try{await runtime.client?.disconnect?.()}catch{}
    runtimes.delete(id);
    await markSessionRepairRequired(id,'AUTH_KEY_UNREGISTERED').catch(e=>console.error('[NexAccount session]',id,'repair_flag_failed',String(e?.message||e).slice(0,180)));
    if(runtime.sessionFingerprint)await releaseSessionLease(runtime.sessionFingerprint,id).catch(()=>{});
    await releaseRuntimeLease(id).catch(()=>{});
    await ensureAnimePublisherOwnership('auth-key-unregistered').catch(()=>{});
    return true;
  })();
  return runtime.authKeyQuarantinePromise;
}

async function quarantineAuthKeyDuplicated(runtime,error,source='runtime'){
  if(!runtime)return false;
  if(runtime.authKeyQuarantinePromise)return runtime.authKeyQuarantinePromise;
  const id=String(runtime.account?.telegramUserId||'');
  runtime.sessionInvalidated=true;
  runtime.sessionInvalidatedAt=new Date();
  runtime.sessionInvalidationReason='AUTH_KEY_DUPLICATED';
  runtime.authKeyQuarantinePromise=(async()=>{
    console.error('[NexAccount session]',id,'AUTH_KEY_DUPLICATED; disabling saved session source='+source,telegramRuntimeErrorText(error).slice(0,240));
    clearRuntimeTimers(runtime);
    await stopEmbeddedLiteApkScanner(runtime).catch(()=>{});
    await stopAnimeIngest(runtime).catch(()=>{});
    try{await runtime.client?.disconnect?.()}catch{}
    runtimes.delete(id);
    await markSessionRepairRequired(id,'AUTH_KEY_DUPLICATED').catch(e=>console.error('[NexAccount session]',id,'repair_flag_failed',String(e?.message||e).slice(0,180)));
    if(runtime.sessionFingerprint)await releaseSessionLease(runtime.sessionFingerprint,id).catch(()=>{});
    await releaseRuntimeLease(id).catch(()=>{});
    await ensureAnimePublisherOwnership('auth-key-duplicated').catch(()=>{});
    return true;
  })();
  return runtime.authKeyQuarantinePromise;
}

function isPrimaryAnimePublisher(account){
  if(!ANIME_PRIMARY_PUBLISHER_ENABLED||!ANIME_PRIMARY_PUBLISHER_USERNAME)return false;
  const username=String(account?.username||'').trim().replace(/^@/,'').toLowerCase();
  return Boolean(username&&username===ANIME_PRIMARY_PUBLISHER_USERNAME);
}

function animeRuntimeUsername(runtime){
  return String(runtime?.account?.username||'').trim().replace(/^@/,'').toLowerCase();
}
function healthyAnimePublisherCandidates(){
  return [...runtimes.values()].filter(runtime=>
    runtime?.sessionInvalidated!==true&&
    runtime?.client?.connected===true&&
    isListenerRuntime(runtime)
  );
}
function preferredAnimePublisher(){
  const candidates=healthyAnimePublisherCandidates();
  if(!candidates.length)return null;
  const primary=candidates.find(runtime=>isPrimaryAnimePublisher(runtime.account));
  if(primary)return primary;
  for(const username of ANIME_PUBLISHER_FAILOVER_USERNAMES){
    const runtime=candidates.find(row=>animeRuntimeUsername(row)===username);
    if(runtime)return runtime;
  }
  return candidates[0];
}
async function expireAnimePublisherLock(ownerId){
  const owner=String(ownerId||'');
  if(!owner)return;
  try{
    const d=await db();
    await d.collection('nexanime_locks').updateOne(
      {_id:'publisher',owner},
      {$set:{expiresAt:new Date(0),updatedAt:new Date(),releasedReason:'publisher_failover'}}
    );
  }catch(error){
    console.warn('[NexAnime failover] publisher lock release failed',owner,String(error?.message||error).slice(0,220));
  }
}
async function ensureAnimePublisherOwnership(source='runtime'){
  if(!EMBEDDED_ANIME_ENABLED)return null;
  if(animePublisherElectionPromise)return animePublisherElectionPromise;
  animePublisherElectionPromise=(async()=>{
    const desired=preferredAnimePublisher();
    const nextId=String(desired?.account?.telegramUserId||'');
    const current=animePublisherRuntimeId?runtimes.get(animePublisherRuntimeId):[...runtimes.values()].find(r=>r?.animePublisher===true);

    // Do not hand the role away while a healthy publisher is in the middle of
    // sending media. The next reconcile pass will perform the handoff cleanly.
    if(
      current&&nextId&&String(current.account?.telegramUserId||'')!==nextId&&
      current?.animeIngest?.publishing===true&&current?.client?.connected===true&&
      current?.sessionInvalidated!==true
    ){
      return current;
    }

    const previousId=String(current?.account?.telegramUserId||animePublisherRuntimeId||'');
    if(previousId&&previousId!==nextId)await expireAnimePublisherLock(previousId);

    for(const runtime of runtimes.values()){
      const shouldPublish=Boolean(nextId&&String(runtime.account?.telegramUserId||'')===nextId);
      const roleChanged=runtime.animePublisher!==shouldPublish;
      runtime.animePublisher=shouldPublish;
      if(roleChanged&&runtime.animeIngest?.enabled===true){
        await stopAnimeIngest(runtime).catch(()=>{});
        if(runtime?.client?.connected===true&&runtime?.sessionInvalidated!==true){
          await startAnimeIngest(runtime).catch(error=>
            console.error('[NexAnime failover]',String(runtime.account?.telegramUserId||''),'restart failed',String(error?.message||error).slice(0,320))
          );
        }
      }
    }

    animePublisherRuntimeId=nextId;
    try{
      const d=await db();
      await d.collection('nexanime_config').updateOne(
        {_id:'publisher-election'},
        {$set:{
          publisherAccountId:nextId,
          publisherUsername:animeRuntimeUsername(desired),
          primaryUsername:ANIME_PRIMARY_PUBLISHER_USERNAME,
          failoverUsernames:ANIME_PUBLISHER_FAILOVER_USERNAMES,
          source:String(source||'runtime'),
          healthyCandidates:healthyAnimePublisherCandidates().map(r=>({
            telegramUserId:String(r.account?.telegramUserId||''),
            username:animeRuntimeUsername(r)
          })),
          updatedAt:new Date()
        }},
        {upsert:true}
      );
    }catch{}

    if(desired){
      console.log('[NexAnime failover] publisher @'+animeRuntimeUsername(desired)+' selected source='+String(source||'runtime'));
    }else{
      console.warn('[NexAnime failover] no healthy publisher candidate source='+String(source||'runtime'));
    }
    return desired;
  })().finally(()=>{animePublisherElectionPromise=null;});
  return animePublisherElectionPromise;
}


const LITEAPK_SCANNER_USERNAME=String(process.env.NEXACCOUNT_LITEAPK_SCANNER_USERNAME||'tresor20009').trim().replace(/^@/,'').toLowerCase();

async function stopEmbeddedLiteApkScanner(runtime){
  if(!runtime)return;
  try{runtime.liteApksScannerAbort?.abort?.()}catch{}
  const running=runtime.liteApksScannerPromise;
  runtime.liteApksScannerAbort=null;
  runtime.liteApksScannerPromise=null;
  runtime.liteApksScannerStartedAt=null;
  if(running){
    await Promise.race([
      Promise.resolve(running).catch(()=>null),
      sleep(2500)
    ]).catch(()=>{});
  }
}

async function startEmbeddedLiteApkScanner(runtime){
  if(!runtime?.client||!runtime?.account)return false;
  const username=String(runtime.account.username||'').trim().replace(/^@/,'').toLowerCase();
  if(!LITEAPK_SCANNER_USERNAME||username!==LITEAPK_SCANNER_USERNAME)return false;
  if(runtime.liteApksScannerPromise)return true;
  try{
    const mod=await import('./automation/liteapks-relay.mjs');
    if(typeof mod.startEmbeddedLiteApksRelay!=='function')throw new Error('embedded_liteapks_entry_missing');
    const controller=new AbortController();
    runtime.liteApksScannerAbort=controller;
    runtime.liteApksScannerStartedAt=new Date();
    const promise=Promise.resolve(mod.startEmbeddedLiteApksRelay(runtime.client,{
      signal:controller.signal,
      expectedUsername:LITEAPK_SCANNER_USERNAME
    }));
    runtime.liteApksScannerPromise=promise;
    runtime.liteApksScannerStartedAt=new Date();
    runtime.liteApksScannerLastError='';
    promise.then(()=>{
      if(runtime.liteApksScannerPromise===promise){
        runtime.liteApksScannerPromise=null;
        runtime.liteApksScannerAbort=null;
      }
      if(controller.signal.aborted)return;
      runtime.liteApksScannerExitCount=Number(runtime.liteApksScannerExitCount||0)+1;
      runtime.liteApksScannerLastExitAt=new Date();
      runtime.liteApksScannerLastError='embedded_scanner_exited';
      console.warn('[NexAccount LiteAPK]',String(runtime.account.telegramUserId),'embedded scanner exited unexpectedly; reconcile will restart it');
    }).catch(async error=>{
      if(runtime.liteApksScannerPromise===promise){
        runtime.liteApksScannerPromise=null;
        runtime.liteApksScannerAbort=null;
      }
      if(controller.signal.aborted)return;
      runtime.liteApksScannerExitCount=Number(runtime.liteApksScannerExitCount||0)+1;
      runtime.liteApksScannerLastExitAt=new Date();
      runtime.liteApksScannerLastError=telegramRuntimeErrorText(error).slice(0,500);
      console.error('[NexAccount LiteAPK]',String(runtime.account.telegramUserId),runtime.liteApksScannerLastError);
      if(isAuthKeyDuplicatedError(error)){
        await quarantineAuthKeyDuplicated(runtime,error,'liteapk-embedded').catch(()=>{});
      }else if(isReconnectableTelegramTransportError(error)){
        console.warn('[NexAccount LiteAPK]',String(runtime.account.telegramUserId),'forcing runtime transport recycle after scanner connection failure');
        try{await runtime.client?.disconnect?.()}catch{}
      }
    });
    console.log('[NexAccount LiteAPK] embedded scanner started @'+username);
    return true;
  }catch(error){
    console.error('[NexAccount LiteAPK] start failed @'+username,String(error?.message||error).slice(0,500));
    return false;
  }
}

function randomLong(){
  return BigInt.asIntN(64,BigInt('0x'+crypto.randomBytes(8).toString('hex')));
}
function utf16len(s){return Buffer.from(String(s),'utf16le').length/2}

function messageAuthorId(message){
  return String(message?.senderId||message?.fromId?.userId||message?.fromId?.channelId||'');
}

function commandChatId(event){
  return String(
    event?.chatId||
    event?.message?.chatId||
    event?.message?.peerId?.channelId||
    event?.message?.peerId?.chatId||
    'global'
  );
}

function isKnownRuntimeCommand(name,settings,event){
  const key=String(name||'').toLowerCase();
  if(!key)return false;
  if(key==='menu'||key==='style'||/^style\d+$/i.test(key)||canHandleStickerCommand(key))return true;

  // Bare/prefixless mode must only accept canonical visible commands.
  // Hidden legacy aliases such as "nom" remain available with an explicit
  // slash/prefix, but must never match ordinary bot replies and feed them back
  // into the command engine.
  const registered=commands.get(key);
  if(registered&&registered.hidden!==true)return true;

  const custom=settings?.groupPolicies?.[commandChatId(event)]?.customCommands;
  return Boolean(custom&&Object.prototype.hasOwnProperty.call(custom,key));
}

function parseRuntimeCommand(text,settings,event){
  return parseCommand(text,settings?.prefix||'.',{
    allowBare:true,
    isKnownCommand:name=>isKnownRuntimeCommand(name,settings,event)
  });
}

function isUniversalPairCommand(parsed){
  const token=String(parsed?.name||'').toLowerCase();
  if(!token)return false;
  const cmd=commands.get(token);
  return String(cmd?.aliasFor||cmd?.name||token).toLowerCase()==='pair';
}

function connectedAccountIds(account){
  return new Set([
    account?.telegramUserId,
    account?.connectedTelegramUserId,
    account?.sessionTelegramUserId
  ].filter(v=>v!==undefined&&v!==null&&String(v)!=='').map(v=>String(v)));
}

async function messageAuthorIsBot(client,message,eventSender=null){
  if(eventSender?.bot===true)return true;
  if(eventSender&&eventSender.bot===false)return false;
  const id=messageAuthorId(message);
  if(!id)return false;
  try{
    const entity=await client.getEntity(id);
    return entity?.bot===true;
  }catch{return false}
}

async function messageAuthorIsOwner(client,message,eventSender=null){
  const directId=String(eventSender?.id||eventSender?.userId||messageAuthorId(message)||'');
  const directUsername=String(eventSender?.username||'');
  if(isOwnerIdentity(directId,directUsername))return true;
  if(!directId)return false;
  try{
    const entity=await client.getEntity(directId);
    return isOwnerIdentity(entity?.id,entity?.username);
  }catch{return false}
}

function isSelfAuthoredMessage(message,account){
  const selfIds=connectedAccountIds(account);
  if(!selfIds.size||!message)return false;
  if(message.out===true)return true;
  const author=messageAuthorId(message);
  if(author&&selfIds.has(author))return true;
  // Saved Messages can be represented as a self peer across synchronized sessions.
  const peerUserId=String(message?.peerId?.userId||'');
  if(peerUserId&&selfIds.has(peerUserId)&&message.fromId==null)return true;
  return false;
}

function messageWasSentViaBot(message){
  return Boolean(
    message?.viaBotId||
    message?.viaBot?.id||
    message?.via_bot_id||
    message?.via_bot?.id
  );
}

function commandDeliveryKey(message){
  const peer=String(
    message?.peerId?.userId||
    message?.peerId?.chatId||
    message?.peerId?.channelId||
    message?.chatId||
    'peer'
  );
  return peer+':'+String(message?.id||'0');
}

function commandSemanticDeliveryKey(message){
  const stamp=messageTimestampMs(message);
  const text=String(message?.message||message?.text||message?.rawText||'')
    .trim()
    .replace(/\\s+/g,' ')
    .toLowerCase();
  if(!stamp||!text)return '';
  const digest=crypto.createHash('sha256').update(text,'utf8').digest('hex').slice(0,24);
  const peer=String(
    message?.peerId?.userId||
    message?.peerId?.chatId||
    message?.peerId?.channelId||
    message?.chatId||
    'peer'
  );
  return peer+':'+String(Math.floor(stamp/1000))+':'+digest;
}

async function claimCommand(telegramUserId,message){
  if(!commandDeduper.claim(telegramUserId,message))return false;
  try{
    const idClaimed=await claimCommandDelivery(telegramUserId,commandDeliveryKey(message));
    if(!idClaimed)return false;

    // A reconnect/catch-up can occasionally surface the same Telegram command
    // with a different update shape (and, on some clients, a different message
    // id). Also claim a stable content+timestamp signature so that one human
    // command can never execute twice across workers or daemon restarts.
    const semanticKey=commandSemanticDeliveryKey(message);
    if(!semanticKey)return true;
    return await claimCommandDelivery(telegramUserId,'semantic:'+semanticKey);
  }catch(error){
    // Keep commands usable during a temporary MongoDB issue; the in-memory
    // guard still prevents duplicate handling inside this runtime.
    console.warn('[NexAccount command-dedupe] durable_claim_failed',String(telegramUserId),String(error?.message||error).slice(0,250));
    return true;
  }
}

function generatedOutputPeerKey(peer){
  return String(
    peer?.userId||
    peer?.chatId||
    peer?.channelId||
    peer?.id||
    peer||
    'peer'
  );
}

function generatedOutputText(value){
  // NexAI's direct renderer appends the visible "By Nextech" signature after
  // sendText() has been called. Strip that transport decoration so the text
  // fingerprint is identical before and after Telegram echoes the outgoing
  // message back to the connected account.
  const raw=String(value??'')
    .replace(/\u2063/g,'')
    .trim()
    .replace(/\s+by nextech\s*$/i,'')
    .trim();
  return raw.replace(/\s+/g,' ').toLowerCase();
}

function messageLooksGeneratedByNexAi(message){
  const raw=String(textOf(message)||'').trim();
  if(!raw)return false;
  // Every normal NexAI text reply rendered by sendBrandedText carries this
  // signature. This is an independent guard in case peer/update shapes differ
  // and the transient fingerprint cannot be matched.
  return /(?:^|\n)\s*By Nextech\s*$/i.test(raw);
}

function generatedOutputKey(accountId,peer,text){
  const normalized=generatedOutputText(text);
  if(!normalized)return '';
  return String(accountId||'')+':'+generatedOutputPeerKey(peer)+':'+normalized;
}

function pruneGeneratedCommandOutputs(now=Date.now()){
  for(const [key,expiresAt] of generatedCommandOutputs){
    if(expiresAt<=now)generatedCommandOutputs.delete(key);
  }
}

function markGeneratedCommandOutput(accountId,peer,text,{ttlMs=60000}={}){
  const key=generatedOutputKey(accountId,peer,text);
  if(!key)return;
  const now=Date.now();
  pruneGeneratedCommandOutputs(now);
  generatedCommandOutputs.set(key,now+Math.max(1000,Number(ttlMs)||60000));
}

function consumeGeneratedCommandOutput(accountId,message){
  const key=generatedOutputKey(accountId,message?.peerId||message?.chatId,textOf(message));
  if(!key)return false;
  const now=Date.now();
  pruneGeneratedCommandOutputs(now);
  const expiresAt=generatedCommandOutputs.get(key);
  if(!expiresAt||expiresAt<=now)return false;
  generatedCommandOutputs.delete(key);
  return true;
}

async function sendText(client,peer,text){
  const value=String(text??'');
  if(!value.trim())return null;
  const runtimeEntry=[...runtimes.entries()].find(([,runtime])=>runtime?.client===client)||null;
  const accountId=runtimeEntry?.[0]||'';
  const runtime=runtimeEntry?.[1]||null;
  const settings=accountId?await settingsFor(accountId).catch(()=>null):null;
  const customEmojiIds=settings?.customEmojiIds||{};

  // Bare commands are parsed from outgoing messages too. Mark every runtime-generated
  // text before sending it so a reply such as "Broadcast terminé" can never be
  // reinterpreted as a fresh prefixless command from the connected account.
  if(accountId)markGeneratedCommandOutput(accountId,peer,value);

  // Try the rich direct path for every connected account. Premium accounts
  // normally accept MessageEntityCustomEmoji directly. If Telegram rejects
  // custom emoji for a non-Premium account, the inline NexAI fallback below
  // can still deliver the same animated entities through the bot.
  if(runtime?.account){
    try{
      return await sendBrandedText(client,peer,value,{
        customEmojiIds,
        emojiLibrary:true,
        emojiLibrarySource:cfg.creatorUsername||'tresor20001'
      });
    }catch(error){
      console.warn('[NexAccount direct rich reply fallback]',String(error?.errorMessage||error?.message||error).slice(0,250));
    }
  }

  if(cfg.botUsername&&accountId){
    try{
      const token=await putInlineResponse(value,{accountId});
      return await sendInline(client,peer,'reply:'+token);
    }catch(error){
      console.warn('[NexAccount inline reply fallback]',String(error?.message||error).slice(0,250));
    }
  }
  return sendBrandedText(client,peer,value,{customEmojiIds});
}

function ownerFormattingEntities(text){
  const out=[new Api.MessageEntityBlockquote({offset:0,length:utf16len(text),collapsed:true})];
  const re=/\/[a-z][a-z0-9_]*/gi;
  for(const m of String(text).matchAll(re)){
    out.push(new Api.MessageEntityBotCommand({
      offset:utf16len(text.slice(0,m.index)),
      length:utf16len(m[0])
    }));
  }
  return out;
}

async function sendOwnerText(client,peer,text){
  const runtimeEntry=[...runtimes.entries()].find(([,runtime])=>runtime?.client===client)||null;
  const accountId=runtimeEntry?.[0]||'';
  const runtime=runtimeEntry?.[1]||null;
  const settings=accountId?await settingsFor(accountId).catch(()=>null):null;
  const safe=sanitizeAnimatedEmojiText(String(text),settings?.customEmojiIds||{});
  // Owner replies intentionally omit the Nextech signature, so fingerprint
  // them explicitly before sending to keep them out of the command parser too.
  if(accountId)markGeneratedCommandOutput(accountId,peer,safe);
  try{
    return await sendBrandedText(client,peer,safe,{
      signature:false,
      customEmojiIds:settings?.customEmojiIds||{},
      emojiLibrary:Boolean(runtime?.account),
      emojiLibrarySource:cfg.creatorUsername||'tresor20001',
      formattingEntities:ownerFormattingEntities(safe)
    });
  }catch{return sendText(client,peer,safe)}
}

function creatorFormattingEntities(model){
  return model.entities.map(e=>{
    if(e.type==='expandable_blockquote'){
      return new Api.MessageEntityBlockquote({offset:e.offset,length:e.length,collapsed:true});
    }
    if(e.type==='text_link'){
      return new Api.MessageEntityTextUrl({offset:e.offset,length:e.length,url:e.url});
    }
    if(e.type==='custom_emoji'&&e.custom_emoji_id){
      try{
        return new Api.MessageEntityCustomEmoji({
          offset:e.offset,
          length:e.length,
          documentId:BigInt(String(e.custom_emoji_id))
        });
      }catch{return null}
    }
    return null;
  }).filter(Boolean);
}

function menuFormattingEntities(model,maxLength=4096){
  return (model?.entities||[]).map(e=>{
    if(e.offset+e.length>maxLength)return null;
    if(e.type==='blockquote'){
      return new Api.MessageEntityBlockquote({offset:e.offset,length:e.length,collapsed:false});
    }
    if(e.type==='expandable_blockquote'){
      return new Api.MessageEntityBlockquote({offset:e.offset,length:e.length,collapsed:true});
    }
    if(e.type==='bot_command'){
      return new Api.MessageEntityBotCommand({offset:e.offset,length:e.length});
    }
    if(e.type==='text_link'){
      return new Api.MessageEntityTextUrl({offset:e.offset,length:e.length,url:e.url});
    }
    if(e.type==='custom_emoji'&&e.custom_emoji_id){
      try{
        return new Api.MessageEntityCustomEmoji({
          offset:e.offset,
          length:e.length,
          documentId:BigInt(String(e.custom_emoji_id))
        });
      }catch{return null}
    }
    return null;
  }).filter(Boolean);
}

async function sendCreator(runtime,peer){
  const {client,account}=runtime;
  const settings=await settingsFor(account.telegramUserId);
  const model=creatorCaptionModel(settings.language||'fr');
  try{
    return await client.sendFile(peer,{
      file:creatorImagePath(),
      caption:model.text,
      formattingEntities:creatorFormattingEntities(model)
    });
  }catch(e){
    console.error('[NexAccount creator]',String(e.message||e));
    return client.sendMessage(peer,{message:model.text,formattingEntities:creatorFormattingEntities(model)}).catch(()=>sendText(client,peer,model.text));
  }
}

async function runtimeBotUsername({refresh=false}={}){
  // The coordinator persists the verified inline-bot identity in Mongo so
  // workers running in separate processes/containers do not depend on a local
  // token file or an in-memory cfg.botUsername value.
  try{
    const shared=await sharedBotIdentity();
    if(shared?.username){
      cfg.botUsername=shared.username;
      return shared.username;
    }
  }catch(error){
    console.warn('[NexAccount bot identity] shared_lookup_failed',String(error?.message||error).slice(0,180));
  }
  return resolveBotUsername({refresh});
}

async function sendInline(client,peer,query){
  const inputPeer=await client.getInputEntity(peer);
  let botUsername=await runtimeBotUsername();
  if(!botUsername)throw new Error('NEXAI_BOT_USERNAME/NEXAI_BOT_TOKEN non configuré');
  const errors=[];
  // Telegram uses random_id as the idempotency key for message sends.
  // Keep ONE id across retries so a transport timeout cannot create duplicates.
  const randomId=randomLong();

  // Every worker resolves the bot identity independently. This avoids a
  // coordinator-only in-memory username and makes newly paired/sharded
  // accounts use the same interactive menu path immediately.
  for(let attempt=0;attempt<4;attempt++){
    try{
      const bot=await client.getInputEntity('@'+botUsername);
      const results=await client.invoke(new Api.messages.GetInlineBotResults({
        bot,peer:inputPeer,query:String(query||'menu'),offset:''
      }));
      const result=results.results?.[0];
      if(!result)throw new Error('NexAI Inline Mode ne renvoie aucun résultat');
      return await client.invoke(new Api.messages.SendInlineBotResult({
        peer:inputPeer,randomId,queryId:results.queryId,id:result.id
      }));
    }catch(error){
      const reason=String(error?.errorMessage||error?.message||error||'unknown_error');
      errors.push(reason.slice(0,350));

      // A stale/missing username is recoverable from the bot token. Refresh it
      // before falling back to a plain-text menu.
      if(attempt===0){
        const refreshed=await runtimeBotUsername({refresh:true}).catch(()=> '');
        if(refreshed)botUsername=refreshed;
      }

      if(/INLINE_DISABLED|BOT_INLINE_DISABLED/i.test(reason))break;
      if(attempt<3)await sleep(250*(attempt+1));
    }
  }
  throw new Error('inline_menu_failed '+errors.join(' | '));
}

async function sendMenu(runtime,peer){
  const {client,account}=runtime;
  try{
    console.log('[NexAccount menu]',String(account.telegramUserId),'inline:start');
    const sent=await sendInline(client,peer,'menu');
    console.log('[NexAccount menu]',String(account.telegramUserId),'inline:sent');
    return sent;
  }catch(error){
    let reason=String(error?.errorMessage||error?.message||error||'unknown_error').slice(0,500);
    console.error('[NexAccount menu]',String(account.telegramUserId),'inline:failed',reason);

    // Existing NexAI bots may predate the automatic BotFather /setinline
    // setup. Repair that setting on demand, then retry the exact same inline
    // menu once before degrading to text.
    if(/INLINE_DISABLED|BOT_INLINE_DISABLED/i.test(reason)){
      try{
        const repair=await ensureNexAiBotPresentation(client,account,{force:true});
        console.log('[NexAccount menu]',String(account.telegramUserId),'inline:repair',JSON.stringify(repair));
        if(repair?.updated===true||repair?.reason==='already_ensured'){
          await sleep(650);
          const sent=await sendInline(client,peer,'menu');
          console.log('[NexAccount menu]',String(account.telegramUserId),'inline:recovered');
          return sent;
        }
      }catch(repairError){
        reason+=' | repair='+String(repairError?.errorMessage||repairError?.message||repairError).slice(0,300);
        console.error('[NexAccount menu]',String(account.telegramUserId),'inline:repair_failed',String(repairError?.message||repairError).slice(0,350));
      }
    }

    const settings=await settingsFor(account.telegramUserId);
    const model=await menuModel({account,settings,commands,view:'home'});

    // Last-resort degradation must never be a header-only card. Preserve the
    // selected theme, then append a compact set of clickable slash commands so
    // the menu remains usable even if Telegram inline mode is temporarily down.
    const quick=String(settings?.language||'fr').toLowerCase().startsWith('en')
      ? '\n\nMENU TEMPORARILY IN TEXT MODE\n/Menu  /Style  /Ping  /Account  /Settings  /Premium  /Owner'
      : '\n\nMENU TEMPORAIRE EN MODE TEXTE\n/Menu  /Style  /Ping  /Account  /Settings  /Premium  /Owner';
    const fallback=(String(model.text||'NexAI')+quick).slice(0,4096);
    const fallbackModel={
      ...model,
      text:fallback,
      entities:[
        ...(model.entities||[]),
        ...[...fallback.matchAll(/\/[A-Za-z][A-Za-z0-9_]{0,63}/g)].map(m=>({
          type:'bot_command',
          offset:utf16len(fallback.slice(0,m.index)),
          length:utf16len(m[0])
        }))
      ]
    };
    try{
      return await client.sendMessage(peer,{
        message:fallback,
        formattingEntities:menuFormattingEntities(fallbackModel,4096)
      });
    }catch{
      return sendBrandedText(client,peer,fallback);
    }
  }
}

function inviteHash(value){
  const s=String(value||'').trim();
  const m=s.match(/(?:t\.me|telegram\.me)\/(?:joinchat\/|\+)([A-Za-z0-9_-]+)/i);
  return m?.[1]||'';
}

async function joinTarget(client,target){
  const raw=String(target||'').trim();
  if(!raw)throw new Error('Cible manquante');
  const hash=inviteHash(raw);
  if(hash)return client.invoke(new Api.messages.ImportChatInvite({hash}));
  const username=raw.replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i,'').replace(/^@/,'').split(/[/?#]/)[0];
  const entity=await client.getInputEntity('@'+username);
  return client.invoke(new Api.channels.JoinChannel({channel:entity}));
}

async function hydratePremiumState(account){
  if(!account)return {active:false,expiresAt:null};
  account.telegramPremium=account.premium===true;
  const state=await nexAiPremiumState(account.telegramUserId).catch(()=>({active:false,expiresAt:null}));
  account.nexaiPremium=isOwnerId(account.telegramUserId)||state.active===true;
  account.nexaiPremiumExpiresAt=state.expiresAt||null;
  return state;
}

async function telegramPremiumDenied(client,peer,name){
  await sendText(client,peer,'Cette commande ('+name+') nécessite Telegram Premium sur le compte connecté. NexAI Premium ne remplace pas Telegram Premium.');
}

async function nexAiPremiumDenied(runtime,peer,name,detail=''){
  const {client}=runtime;
  const suffix=detail?'\n'+detail:'';
  await sendText(client,peer,'Cette commande ('+name+') nécessite NexAI Premium.'+suffix+'\nAbonnement : 250 ⭐ / 30 jours.');
  try{
    await sendInline(client,peer,'cat:PREMIUM');
  }catch(error){
    console.warn('[NexAI premium menu]',String(error?.errorMessage||error?.message||error).slice(0,300));
  }
}

async function handleStyle(runtime,peer,args,inlineName=''){
  const {account,client}=runtime;
  let n=Number(args?.[0]||inlineName.replace(/^style/i,''));
  if(!n){
    try{
      await sendInline(client,peer,'styles');
      return true;
    }catch(error){
      console.error('[NexAccount styles]',String(account.telegramUserId),'inline:failed',String(error?.errorMessage||error?.message||error).slice(0,350));
      const settings=await settingsFor(account.telegramUserId);
      const model=await stylesModel({account,settings});
      return sendText(client,peer,String(model.text||'NexAI · Styles'));
    }
  }
  const styles=await listStyles();
  if(!styles.some(s=>s.id===n)||n===0){
    await sendText(client,peer,'Style invalide. Utilise .style pour afficher les styles disponibles.');
    return;
  }
  await patchSettings(account.telegramUserId,{style:n});
  // Re-render immediately so a text command such as .style20 visibly applies
  // the new theme/artwork without requiring a second .menu command.
  return sendMenu(runtime,peer);
}

const LOCAL_OWNER_COMMANDS=new Set([
  'owner','users','botstats','activity','growth','commandstats','countries','languages','user'
]);

async function handleOwner(runtime,peer,name,args){
  const {client,account}=runtime;
  const settings=await settingsFor(account.telegramUserId);
  const lang=String(settings.language||'fr').toLowerCase().startsWith('en')?'en':'fr';
  let text='';
  if(name==='owner')text=await ownerPanelText(lang);
  else if(name==='users')text=await usersText(lang);
  else if(name==='botstats')text=await botStatsText(lang);
  else if(name==='activity')text=await activityText(lang);
  else if(name==='growth')text=await growthText(lang);
  else if(name==='commandstats')text=await commandStatsText(lang);
  else if(name==='countries')text=await countriesText(lang);
  else if(name==='languages')text=await languagesText(lang);
  else if(name==='user')text=await userText(args[0]||'',lang);
  if(text)await sendOwnerText(client,peer,text);
  return true;
}

function eventIsGroup(event){
  if(event?.isGroup===true)return true;
  const peer=event?.message?.peerId;
  return Boolean(peer?.chatId)||Boolean(peer?.channelId&&event?.isPrivate!==true);
}

async function userIsGroupAdmin(client,peer,userId){
  const id=String(userId||'');
  if(!id)return false;
  try{
    if(typeof client.getPermissions==='function'){
      const p=await client.getPermissions(peer,id);
      if(p?.isCreator||p?.isAdmin||p?.adminRights)return true;
    }
  }catch{}
  try{
    const channel=getInputChannel(await client.getInputEntity(peer));
    const participant=await client.getInputEntity(id);
    const r=await client.invoke(new Api.channels.GetParticipant({channel,participant}));
    const p=r?.participant;
    const kind=String(p?.className||p?.constructor?.name||'');
    if(/Creator|Admin/i.test(kind)||p?.adminRights)return true;
  }catch{}
  try{
    const ps=await client.getParticipants(peer,{limit:500});
    const user=ps.find(p=>String(p?.id||'')===id);
    const kind=String(user?.participant?.className||user?.participant?.constructor?.name||'');
    if(/Creator|Admin/i.test(kind)||user?.participant?.adminRights||user?.adminRights)return true;
  }catch{}
  return false;
}

async function accountIsGroupAdmin(client,peer,account){
  return userIsGroupAdmin(client,peer,account?.telegramUserId);
}

async function enforceCommandContext(runtime,event,cmd,displayName){
  const {client,account}=runtime;
  const peer=event.message.peerId;
  const group=eventIsGroup(event);
  const selfAuthored=isSelfAuthoredMessage(event.message,account);
  const ownerCaller=event?.callerOwner===true;

  if(cmd.selfOnly&&!selfAuthored&&!ownerCaller){
    // Ignore silently: replying to foreign/bot traffic can create feedback loops.
    return false;
  }
  if(cmd.privateOnly&&group){
    await sendText(client,peer,'La commande .'+displayName+' est réservée au privé.');
    return false;
  }
  if(cmd.groupOnly&&!group){
    await sendText(client,peer,'La commande .'+displayName+' est réservée aux groupes.');
    return false;
  }
  if(cmd.adminOnly){
    if(!group){
      await sendText(client,peer,'La commande .'+displayName+' nécessite un groupe.');
      return false;
    }
    if(!(await accountIsGroupAdmin(client,peer,account))){
      await sendText(client,peer,'Le compte connecté doit être administrateur pour exécuter .'+displayName+'.');
      return false;
    }
    if(!selfAuthored){
      const callerId=messageAuthorId(event.message);
      if(!callerId||!(await userIsGroupAdmin(client,peer,callerId))){
        await sendText(client,peer,'La commande .'+displayName+' est réservée aux administrateurs du groupe.');
        return false;
      }
    }
  }
  return true;
}

async function handleCommand(runtime,event,parsed){
  const {client,account}=runtime;
  const peer=event.message.peerId;
  await hydratePremiumState(account);
  if(/^style\d+$/i.test(parsed.name))return handleStyle(runtime,peer,[],parsed.name);
  if(parsed.name==='style')return handleStyle(runtime,peer,parsed.args);
  if(parsed.name==='menu')return sendMenu(runtime,peer);

  let cmd=commands.get(parsed.name);
  // Sticker commands are also owned by sticker-engine. If the registry and runtime
  // ever drift during a rolling deploy, route a known sticker command directly
  // instead of incorrectly replying "Commande inconnue".
  if(!cmd&&canHandleStickerCommand(parsed.name)){
    cmd={name:String(parsed.name||'').toLowerCase(),engine:'sticker',selfOnly:true,description:'Sticker engine fallback'};
  }
  if(!cmd){
    const settings=await settingsFor(account.telegramUserId);
    const chatId=String(event.chatId||event.message?.chatId||event.message?.peerId?.channelId||event.message?.peerId?.chatId||'global');
    const custom=settings.groupPolicies?.[chatId]?.customCommands?.[parsed.name];
    if(custom){await sendText(client,peer,String(custom));return true}
    return false;
  }
  if(cmd.ownerOnly&&event?.callerOwner!==true){
    await sendText(client,peer,'Commande réservée au propriétaire de NexAi.');
    return true;
  }
  if(!(await enforceCommandContext(runtime,event,cmd,parsed.name)))return true;

  const canonicalCommand=cmd.aliasFor||cmd.name;
  const name=cmd.handler||canonicalCommand;
  // Aliases are alternate spellings of the same command. Analytics must always
  // attribute usage to the canonical command so aliases never become separate stats.
  await recordEvent(account,'command',{source:'nexaccount',command:canonicalCommand,chatType:eventIsGroup(event)?'group':'private'}).catch(()=>{});

  if(name==='creator')return sendCreator(runtime,peer);
  // ownerOnly is an access-control flag, not an execution engine.
  // Only the native NexAI owner dashboard commands belong to handleOwner().
  // Other owner-only commands (mostly THE BIG DIPPER commands) must continue
  // through local compatibility routing after the owner identity check above.
  if(cmd.ownerOnly&&LOCAL_OWNER_COMMANDS.has(name))return handleOwner(runtime,peer,name,parsed.args);

  const telegramPremium=account.telegramPremium===true||account.premium===true;
  if((cmd.telegramPremium||cmd.premium)&&!telegramPremium){
    await telegramPremiumDenied(client,peer,name);
    return true;
  }
  if(cmd.nexaiPremium&&!account.nexaiPremium){
    await nexAiPremiumDenied(runtime,peer,name);
    return true;
  }
  if(name==='premium'){
    try{return await sendInline(client,peer,'cat:PREMIUM')}
    catch{
      const state=account.nexaiPremium?'ACTIF':'INACTIF';
      await sendText(client,peer,'NexAI Premium : '+state+' · 250 ⭐ / 30 jours\nTelegram Premium : '+(telegramPremium?'ACTIF':'INACTIF'));
      return true;
    }
  }
  const engineHandled=await routeEngineCommand({
    cmd,
    runtime,
    event,
    args:parsed.args,
    sendText,
    onNexAiPremiumRequired:async(error)=>{
      const reset=error?.resetAt?new Date(error.resetAt).toISOString().replace('T',' ').slice(0,16)+' UTC':'dans 3 jours';
      const detail=error?.quotaKey==='clonepack'
        ?'Quota Free atteint : 2 clonages tous les 3 jours. Réinitialisation : '+reset+'.'
        :String(error?.message||'').replace(/^NEXAI_PREMIUM_REQUIRED:?\s*/,'');
      await nexAiPremiumDenied(runtime,peer,name,detail);
    }
  });
  if(engineHandled)return true;

  const compatHandled=await handleCompatCommand({
    runtime,event,name,args:parsed.args,cmd,sendText,sendInline
  });
  if(compatHandled)return true;

  if(cmd.localOnly){
    await sendText(client,peer,'Erreur interne : la route locale de .'+cmd.name+' est indisponible.');
    return true;
  }

  switch(name){
    case 'ping':{
      const t=Date.now();
      await sendText(client,peer,'Pong · '+Math.max(1,Date.now()-t)+' ms');
      return true;
    }
    case 'alive':
      await sendText(client,peer,'NexAi · Dipper est actif sur ce compte.');
      return true;
    case 'account':
      await sendText(client,peer,'Compte : '+(account.username?'@'+account.username:account.firstName)+'\nTelegram Premium : '+(telegramPremium?'Oui':'Non')+'\nNexAI Premium : '+(account.nexaiPremium?'Oui':'Non')+'\nNexAccount : connecté');
      return true;
    case 'help':
      await sendText(client,peer,'Utilise menu (ou .menu / /menu) pour afficher le menu interactif.');
      return true;
    case 'join':
      try{await joinTarget(client,parsed.args[0]);await sendText(client,peer,'Cible rejointe.')}
      catch(e){await sendText(client,peer,'Impossible de rejoindre : '+String(e.errorMessage||e.message||e))}
      return true;
    case 'leave':
      try{
        const inputPeer=await client.getInputEntity(peer);
        await client.invoke(new Api.channels.LeaveChannel({channel:inputPeer}));
      }catch(e){await sendText(client,peer,'Impossible de quitter ce chat : '+String(e.errorMessage||e.message||e))}
      return true;
    default:
      await sendText(client,peer,'Erreur interne : aucune route d’exécution disponible pour .'+name+'.');
      return true;
  }
}

function eventChatKey(event){
  const message=event?.message||{};
  return String(event?.chatId||message.chatId||message.peerId?.channelId||message.peerId?.chatId||message.peerId?.userId||'global');
}

function autoFeaturesMuted(settings,event){
  const policy=settings?.groupPolicies?.[eventChatKey(event)]||{};
  if(policy.nexaiMuted!==true)return false;
  const until=Number(policy.nexaiMuteUntil||0);
  return until===0||until>Date.now();
}

function messageMentionsAccount(message,account){
  const id=String(account.telegramUserId||'');
  const username=String(account.username||'').replace(/^@/,'').toLowerCase();
  const text=textOf(message);
  if(username&&text.toLowerCase().includes('@'+username))return true;
  for(const entity of message?.entities||[]){
    const userId=String(entity?.userId||entity?.user?.id||'');
    if(userId&&userId===id)return true;
  }
  return false;
}

async function repliedToConnectedAccount(client,event,account){
  const id=Number(event?.message?.replyTo?.replyToMsgId||event?.message?.replyToMsgId||0);
  if(!id)return false;
  try{
    const rows=await client.getMessages(event.message.peerId,{ids:[id]});
    const source=Array.isArray(rows)?rows[0]:rows;
    return isSelfAuthoredMessage(source,account);
  }catch{return false}
}

async function maybeNlpMode(runtime,event){
  const {client,account}=runtime;
  const settings=await settingsFor(account.telegramUserId);
  if(settings.nlpMode?.enabled!==true||autoFeaturesMuted(settings,event))return false;
  const message=event?.message;
  const raw=textOf(message);
  if(!raw||message?.media||isSelfAuthoredMessage(message,account))return false;
  const prefix=String(settings.prefix||'.');
  if((prefix&&raw.startsWith(prefix))||raw.startsWith('/'))return false;
  if(event?.sender?.bot===true)return false;

  const group=eventIsGroup(event);
  if(group){
    const mentioned=messageMentionsAccount(message,account);
    const replied=mentioned?false:await repliedToConnectedAccount(client,event,account);
    if(!mentioned&&!replied)return false;
  }

  const chat=eventChatKey(event),windowKey=String(account.telegramUserId)+':'+chat;
  const now=Date.now(),last=Number(aiAutoWindows.get(windowKey)||0);
  if(now-last<2500)return false;
  aiAutoWindows.set(windowKey,now);

  const username=String(account.username||'').replace(/^@/,'');
  const prompt=username?raw.replace(new RegExp('@'+username+'\\b','ig'),'').trim()||raw:raw;
  try{
    const inputPeer=await client.getInputEntity(message.peerId);
    await client.invoke(new Api.messages.SetTyping({peer:inputPeer,action:new Api.SendMessageTypingAction({})})).catch(()=>{});
    const result=await generateAiReply({
      accountId:account.telegramUserId,
      peer:chat,
      prompt,
      mode:'ai',
      language:settings.language||account.preferredLanguage||'fr'
    });
    await sendText(client,message.peerId,result.text);
    return true;
  }catch(e){
    console.error('[NexAccount nlp]',account.telegramUserId,String(e?.message||e));
    return false;
  }
}

function mentionReplyStorageKey(storage={}){
  return String(storage?.fileUniqueId||storage?.fileId||'').trim();
}

function mentionReplyExistingMedia(message){
  return message?.media?.document||message?.media||null;
}

async function loadMentionReplyHotMedia(runtime,configured){
  const hotMessageId=Number(configured?.hotMessageId||0);
  if(!hotMessageId)return null;
  if(runtime.mentionVideoReplyHotMessageId===hotMessageId&&runtime.mentionVideoReplyTelegramMedia){
    return runtime.mentionVideoReplyTelegramMedia;
  }
  const cachePeer=replyHotCachePeer(configured);
  if(!cachePeer)return null;
  const rows=await runtime.client.getMessages(cachePeer,{ids:[hotMessageId]});
  const source=Array.isArray(rows)?rows[0]:rows;
  const media=mentionReplyExistingMedia(source);
  if(!media)return null;
  runtime.mentionVideoReplyHotMessageId=hotMessageId;
  runtime.mentionVideoReplyTelegramMedia=media;
  return media;
}

async function warmMentionVideoReply(runtime){
  const id=String(runtime?.account?.telegramUserId||'');
  if(!id)return null;
  const settings=await settingsFor(id);
  let configured=settings.mentionVideoReply||{};
  runtime.mentionVideoReplyCache=configured;
  const storage=configured.storage||{};
  if(configured.enabled!==true||!storage.fileId)return configured;

  let buffer=null;
  if(storage.mediaType!=='video_note'||storage.normalized!==true||!storage.videoNoteMeta?.width||!storage.videoNoteMeta?.height){
    buffer=await downloadReplyVideo(storage);
    let readyBuffer=buffer;
    let meta=storage.videoNoteMeta||{};
    if(storage.normalized!==true||!meta?.width||!meta?.height){
      const normalized=await normalizeVideoNoteBuffer(buffer);
      readyBuffer=normalized.buffer;
      meta={width:normalized.width,height:normalized.height,duration:normalized.duration};
    }
    const replacement=await storeReplyVideo(readyBuffer,{
      telegramUserId:id,
      filenamePrefix:'nexai-reply-ready',
      videoNote:true
    });
    replacement.normalized=true;
    replacement.videoNoteMeta=meta;
    if(replacement.mediaType!=='video_note')throw new Error('coffre Telegram : note vidéo invalide');
    const next={...configured,storage:replacement,mime:'video/mp4',normalizedAt:Date.now()};
    await patchSettings(id,{mentionVideoReply:next});
    runtime.mentionVideoReplyCache=next;
    configured=next;
    await deleteStoredReplyVideo(storage).catch(()=>false);
  }

  const hotCache=await ensureReplyHotCacheChannel(runtime.client,configured);
  const hotMessageId=Number(configured.storage?.messageId||0);
  const next={
    ...configured,
    ...hotCache.ref,
    hotMessageId,
    hotPreparedAt:Date.now()
  };
  let hotMedia=await loadMentionReplyHotMedia(runtime,next).catch(()=>null);
  if(!hotMessageId||!hotMedia)throw new Error('note vidéo du coffre Telegram introuvable');
  await patchSettings(id,{mentionVideoReply:next});
  runtime.mentionVideoReplyCache=next;
  configured=next;
  runtime.mentionVideoReplyHotMessageId=hotMessageId;
  runtime.mentionVideoReplyTelegramMedia=hotMedia;
  runtime.mentionVideoReplyBuffer=null;
  runtime.mentionVideoReplyBufferKey=mentionReplyStorageKey(configured.storage);
  return configured;
}

async function maybeMentionVideoReply(runtime,event){
  const {client,account}=runtime;
  if(runtime.mentionReplyWarmupPromise){
    await runtime.mentionReplyWarmupPromise.catch(()=>null);
  }
  const configured=runtime.mentionVideoReplyCache;
  const message=event?.message;
  if(configured?.enabled!==true||!configured?.storage?.fileId||!message?.peerId)return false;
  if(isSelfAuthoredMessage(message,account)||!messageMentionsAccount(message,account))return false;
  if(message?.fromId?.channelId)return false;
  if(await messageAuthorIsBot(client,message,event?.sender))return false;
  try{
    let hotMedia=runtime.mentionVideoReplyTelegramMedia;
    if(!hotMedia){
      hotMedia=await loadMentionReplyHotMedia(runtime,configured);
    }
    if(!hotMedia)throw new Error('média Telegram rapide absent');
    await client.sendFile(message.peerId,{
      file:hotMedia,
      caption:'',
      replyTo:Number(message.id||0)||undefined
    });
    return true;
  }catch(e){
    console.error('[NexAccount mentionVideoReply]',account.telegramUserId,String(e?.message||e));
    return false;
  }
}

async function maybeAutoReply(runtime,event){
  const {client,account}=runtime;
  const settings=await settingsFor(account.telegramUserId);
  const auto=settings.autoReply||{};
  if(auto.enabled!==true||!(auto.savedMessageId||auto.url)||autoFeaturesMuted(settings,event))return false;
  if(!messageMentionsAccount(event.message,account))return false;
  const delay=Math.max(0,Math.min(30000,Number(auto.delayMs)||0));
  if(delay)await sleep(delay);
  try{
    let buffer=null;
    let mime=String(auto.mime||'application/octet-stream');
    if(auto.savedMessageId){
      const rows=await client.getMessages('me',{ids:[Number(auto.savedMessageId)]});
      const source=Array.isArray(rows)?rows[0]:rows;
      if(!source?.media)throw new Error('média Telegram introuvable');
      buffer=await client.downloadMedia(source);
      mime=String(auto.mime||source?.document?.mimeType||source?.media?.document?.mimeType||mime);
    }else{
      const response=await fetch(String(auto.url),{signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error('HTTP '+response.status);
      const size=Number(response.headers.get('content-length')||0);
      if(size>20*1024*1024)throw new Error('média > 20 Mo');
      buffer=Buffer.from(await response.arrayBuffer());
      mime=String(auto.mime||response.headers.get('content-type')||mime);
    }
    if(!buffer?.length)throw new Error('média vide');
    if(buffer.length>20*1024*1024)throw new Error('média > 20 Mo');
    await sendTelegramMedia(client,event.message.peerId,Buffer.from(buffer),{fileName:'nexai-autoreply',mimeType:mime,kind:'auto'});
    return true;
  }catch(e){
    console.error('[NexAccount autoReply]',account.telegramUserId,String(e.message||e));
    return false;
  }
}

function normalizeAutomationTarget(value){
  return String(value||'').trim().toLowerCase()
    .replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i,'')
    .replace(/^@/,'')
    .split(/[/?#]/)[0];
}

function autoReactionKey(value){
  const v=String(value||'').replace(/\uFE0F/g,'').trim();
  if(v==='🔥')return 'FIRE';
  if(v==='❤')return 'HEART';
  if(v==='👍')return 'LIKE';
  return '';
}

function recordAutoReact(runtime,{ok,target='',messageId=0,reaction='',animated=false,error=''}={}){
  runtime.autoReactStats=runtime.autoReactStats||{successes:0,failures:0};
  runtime.autoReactStats.lastAttemptAt=new Date();
  runtime.autoReactStats.lastTarget=String(target||'');
  runtime.autoReactStats.lastMessageId=Number(messageId||0);
  runtime.autoReactStats.lastReaction=String(reaction||'');
  runtime.autoReactStats.lastAnimated=animated===true;
  runtime.autoReactStats.lastError=String(error||'').slice(0,300);
  if(ok){
    runtime.autoReactStats.successes=(runtime.autoReactStats.successes||0)+1;
    runtime.autoReactStats.lastSuccessAt=new Date();
  }else{
    runtime.autoReactStats.failures=(runtime.autoReactStats.failures||0)+1;
    runtime.autoReactStats.lastFailureAt=new Date();
  }
}

async function ensureAutomationConnection(runtime){
  const {client,account}=runtime;
  if(client.connected===true)return {ok:true,reconnected:false};
  try{
    await client.connect();
    if(client.connected!==true)throw new Error('telegram_reconnect_failed');
    await client.catchUp().catch(()=>{});
    console.log('[NexAccount automation]',String(account.telegramUserId),'reconnected');
    return {ok:true,reconnected:true};
  }catch(error){
    const reason=telegramRuntimeErrorText(error).slice(0,300);
    console.error('[NexAccount automation]',String(account.telegramUserId),'reconnect_failed',reason);
    return {ok:false,reconnected:false,error:reason};
  }
}
function reactionCanonical(value){return String(value||'').replace(/\uFE0F/g,'').trim()}
async function globalReactionEmoticons(client,account){
  try{
    const result=await client.invoke(new Api.messages.GetAvailableReactions({hash:0}));
    const rows=Array.isArray(result?.reactions)?result.reactions:[];
    return rows.filter(x=>x?.inactive!==true&&(account?.premium===true||x?.premium!==true))
      .map(x=>String(x?.reaction||'').trim()).filter(Boolean);
  }catch{return []}
}
async function channelReactionPolicy(client,inputPeer){
  try{
    const channel=getInputChannel(inputPeer);
    const full=await client.invoke(new Api.channels.GetFullChannel({channel}));
    const available=full?.fullChat?.availableReactions??full?.fullChat?.available_reactions??null;
    const kind=String(available?.className||available?.constructor?.name||'');
    if(!available||/ChatReactionsNone/i.test(kind))return {mode:'none',emoticons:[],customIds:[]};
    if(/ChatReactionsAll/i.test(kind))return {mode:'all',emoticons:null,customIds:null,allowCustom:available?.allowCustom===true};
    if(/ChatReactionsSome/i.test(kind)){
      const reactions=Array.isArray(available?.reactions)?available.reactions:[];
      return {
        mode:'some',
        emoticons:reactions.map(x=>String(x?.emoticon||'').trim()).filter(Boolean),
        customIds:reactions.map(x=>String(x?.documentId||x?.document_id||'').trim()).filter(x=>/^\d{5,30}$/.test(x))
      };
    }
    return {mode:'unknown',emoticons:null,customIds:null};
  }catch(error){
    return {mode:'unknown',emoticons:null,customIds:null,error:telegramRuntimeErrorText(error).slice(0,220)};
  }
}
function preferredStandardReactions(configured,global){
  const preferred=[...(Array.isArray(configured)?configured:[]),'🔥','❤️','👍','❤','👏','😁'];
  const globalRows=[...new Set((global||[]).filter(Boolean))];
  const out=[];
  for(const wanted of preferred){
    const found=globalRows.find(x=>reactionCanonical(x)===reactionCanonical(wanted));
    if(found&&!out.includes(found))out.push(found);
  }
  for(const value of globalRows){if(!out.includes(value))out.push(value)}
  return out;
}
async function ensureReactionPolicy(runtime,inputPeer,configured){
  const {client,account}=runtime;
  const global=await globalReactionEmoticons(client,account);
  let policy=await channelReactionPolicy(client,inputPeer);
  if(policy.mode==='none'){
    const selected=preferredStandardReactions(configured,global).slice(0,3);
    if(selected.length&&typeof Api.messages.SetChatAvailableReactions==='function'&&typeof Api.ChatReactionsSome==='function'){
      try{
        await client.invoke(new Api.messages.SetChatAvailableReactions({
          peer:inputPeer,
          availableReactions:new Api.ChatReactionsSome({reactions:selected.map(emoticon=>new Api.ReactionEmoji({emoticon}))})
        }));
        policy={mode:'some',emoticons:selected,customIds:[],enabledByNexAi:true};
        console.log('[NexAccount auto-react]',String(account.telegramUserId),'enabled_channel_reactions',selected.join(','));
      }catch(error){
        const reason=telegramRuntimeErrorText(error);
        if(!/CHAT_NOT_MODIFIED/i.test(reason))return {...policy,global,error:reason.slice(0,300)};
        policy=await channelReactionPolicy(client,inputPeer);
      }
    }
  }
  return {...policy,global};
}
async function sendConfiguredReaction(runtime,peer,messageId,settings,target=''){
  const {client,account}=runtime;
  const connection=await ensureAutomationConnection(runtime);
  if(!connection.ok){
    recordAutoReact(runtime,{ok:false,target,messageId,error:connection.error});
    return {ok:false,target,messageId:Number(messageId),error:connection.error};
  }
  const inputPeer=await client.getInputEntity(peer);
  const configured=Array.isArray(settings.autoReact?.reactions)&&settings.autoReact.reactions.length?settings.autoReact.reactions:['🔥','❤️','👍'];
  const policy=await ensureReactionPolicy(runtime,inputPeer,configured);
  let candidates=preferredStandardReactions(configured,policy.global||[]);
  if(policy.mode==='some'){
    const allowed=new Set((policy.emoticons||[]).map(reactionCanonical));
    candidates=candidates.filter(x=>allowed.has(reactionCanonical(x)));
  }else if(policy.mode==='none')candidates=[];
  let lastError=policy.error||'';
  for(const emoticon of candidates){
    try{
      await client.invoke(new Api.messages.SendReaction({peer:inputPeer,msgId:Number(messageId),reaction:[new Api.ReactionEmoji({emoticon})]}));
      recordAutoReact(runtime,{ok:true,target,messageId,reaction:emoticon,animated:false});
      console.log('[NexAccount auto-react]',String(account.telegramUserId),'ok',target||'unknown','msg='+String(messageId),'reaction='+emoticon,'policy='+policy.mode);
      return {ok:true,target,messageId:Number(messageId),reaction:emoticon,animated:false,policy:policy.mode,reactionsEnabledByNexAi:policy.enabledByNexAi===true};
    }catch(error){lastError=telegramRuntimeErrorText(error)}
  }
  if(account.premium===true&&Array.isArray(policy.customIds)){
    for(const documentId of policy.customIds){
      try{
        await client.invoke(new Api.messages.SendReaction({peer:inputPeer,msgId:Number(messageId),reaction:[new Api.ReactionCustomEmoji({documentId:BigInt(documentId)})]}));
        recordAutoReact(runtime,{ok:true,target,messageId,reaction:'custom:'+documentId,animated:true});
        return {ok:true,target,messageId:Number(messageId),reaction:'custom',animated:true,policy:policy.mode};
      }catch(error){lastError=telegramRuntimeErrorText(error)}
    }
  }
  const error=String(lastError||('no_allowed_reaction policy='+policy.mode)).slice(0,300);
  recordAutoReact(runtime,{ok:false,target,messageId,error});
  console.error('[NexAccount auto-react]',String(account.telegramUserId),'failed',target||'unknown',error);
  return {ok:false,target,messageId:Number(messageId),error,policy:policy.mode,allowed:policy.emoticons||[]};
}

function isWildcardAutoReactTarget(value){
  const v=String(value||'').trim().toLowerCase();
  return v==='*'||v==='all'||v==='all_channels'||v==='toutes_les_chaines';
}

function safeAutoReactTargets(rawTargets){
  const explicit=(Array.isArray(rawTargets)?rawTargets:[])
    .filter(x=>!isWildcardAutoReactTarget(x))
    .map(normalizeAutomationTarget)
    .filter(Boolean);
  const configured=(Array.isArray(cfg.autoReactTargets)?cfg.autoReactTargets:[])
    .filter(x=>!isWildcardAutoReactTarget(x))
    .map(normalizeAutomationTarget)
    .filter(Boolean);
  return [...new Set([...configured,...explicit])];
}

async function maybeAutoReact(runtime,event){
  const {client,account}=runtime;
  const message=event?.message;
  if(!message?.peerId||!message?.id)return null;
  const settings=await settingsFor(account.telegramUserId);
  if(autoFeaturesMuted(settings,event))return null;
  const cfgReact=settings.autoReact||{};

  const storedTargets=Array.isArray(cfgReact.targets)?cfgReact.targets:[];
  const targets=safeAutoReactTargets(storedTargets);
  if(!targets.length)return null;

  // Legacy settings used "*" to mean every joined broadcast channel. That is
  // intentionally no longer supported: auto-react is restricted to the
  // configured owner allowlist. Migrate old rows opportunistically.
  if(storedTargets.some(isWildcardAutoReactTarget)){
    patchSettings(account.telegramUserId,{
      autoReact:{...cfgReact,targets}
    }).catch(error=>console.warn(
      '[NexAccount auto-react]',
      String(account.telegramUserId),
      'target_migration_failed',
      String(error?.message||error).slice(0,220)
    ));
  }

  const chatId=String(event.chatId||message.chatId||message.peerId?.channelId||'');
  let chat=event.chat||null;
  if(!chat){try{chat=await client.getEntity(message.peerId)}catch{}}
  const username=normalizeAutomationTarget(chat?.username||'');
  const matchedTarget=targets.find(x=>x===chatId||x===username);
  if(!matchedTarget)return null;

  const managedTargets=(Array.isArray(cfg.managedAutoReactTargets)?cfg.managedAutoReactTargets:[])
    .map(normalizeAutomationTarget)
    .filter(Boolean);
  const managed=managedTargets.includes(matchedTarget)||managedTargets.includes(username);
  if(cfgReact.enabled!==true&&!managed)return null;

  return sendConfiguredReaction(
    runtime,
    message.peerId,
    message.id,
    settings,
    matchedTarget||username||chatId||'channel'
  );
}

async function maybeAutoModerate(runtime,event){
  const {client,account}=runtime;
  const message=event.message;if(!message)return;
  const settings=await settingsFor(account.telegramUserId);
  const chatId=String(event.chatId||message.chatId||message.peerId?.channelId||message.peerId?.chatId||'global');
  const policy=settings.groupPolicies?.[chatId]||{};
  const text=textOf(message);
  const sender=String(message.senderId||event.senderId||'');
  if(Array.isArray(policy.whitelist)&&policy.whitelist.map(String).includes(sender))return;
  let remove=Array.isArray(policy.blacklist)&&policy.blacklist.map(String).includes(sender);
  if(!remove&&policy.antilink&&/(?:https?:\/\/|t\.me\/|telegram\.me\/|www\.)/i.test(text))remove=true;
  if(!remove&&policy.antitag&&/@[A-Za-z0-9_]{3,}/.test(text))remove=true;
  if(!remove&&policy.antigroupmention&&(text.match(/@[A-Za-z0-9_]{3,}/g)||[]).length>=5)remove=true;
  if(!remove&&policy.antibadword){
    const bad=Array.isArray(policy.badwords)?policy.badwords:[];
    if(bad.some(w=>w&&text.toLowerCase().includes(String(w).toLowerCase())))remove=true;
  }
  if(!remove&&policy.antispam&&sender){
    const key=account.telegramUserId+':'+chatId+':'+sender,now=Date.now();
    const recent=(spamWindows.get(key)||[]).filter(t=>now-t<10000);recent.push(now);spamWindows.set(key,recent);
    if(recent.length>5)remove=true;
  }
  if(remove){
    // Never let automatic filters punish Telegram bots or group administrators.
    // Explicit moderation commands remain available to admins when action is intended.
    if(await messageAuthorIsBot(client,message,event?.sender))return;
    if(sender&&await userIsGroupAdmin(client,message.peerId,sender))return;
    try{await client.deleteMessages(message.peerId,[message.id],{revoke:true})}catch{}
  }
}

function greetingEventKey(runtime,event){
  const message=event?.message;
  const peer=message?.peerId;
  const chat=String(peer?.channelId||peer?.chatId||event?.chatId||'');
  const id=String(message?.id||'');
  const kind=String(message?.action?.className||message?.action?.constructor?.name||'');
  if(!chat||!id||!kind)return '';
  return [String(runtime?.account?.telegramUserId||''),chat,id,kind].join(':');
}

function claimGreetingEvent(runtime,event){
  const key=greetingEventKey(runtime,event);
  if(!key)return {ok:true,key:''};
  const now=Date.now();
  for(const [seenKey,at] of greetingEventsSeen){
    if(now-at>120000)greetingEventsSeen.delete(seenKey);
  }
  if(greetingEventsSeen.has(key))return {ok:false,key};
  greetingEventsSeen.set(key,now);
  return {ok:true,key};
}

function rawServiceGreetingEvent(update){
  if(!(update instanceof Api.UpdateNewMessage||update instanceof Api.UpdateNewChannelMessage))return null;
  const message=update?.message;
  if(!message?.action||!message?.peerId)return null;
  return {
    message,
    chatId:message?.peerId?.channelId||message?.peerId?.chatId||null,
    isGroup:!!(message?.peerId?.chatId||message?.peerId?.channelId)
  };
}

function greetingActionUserIds(message,action,kind){
  const ids=[];
  if(/ChatAddUser/i.test(kind)&&Array.isArray(action?.users)){
    for(const id of action.users)if(id!=null)ids.push(id);
  }
  if(/ChatDeleteUser/i.test(kind)&&action?.userId!=null)ids.push(action.userId);
  if((/ChatJoinedByLink|ChatJoinedByRequest/i.test(kind)||!ids.length)&&message?.fromId?.userId!=null){
    ids.push(message.fromId.userId);
  }
  const seen=new Set();
  return ids.filter(id=>{
    const key=String(id||'');
    if(!key||seen.has(key))return false;
    seen.add(key);
    return true;
  }).slice(0,10);
}

function greetingDisplayName(user){
  return String([user?.firstName,user?.lastName].filter(Boolean).join(' ')||user?.username||user?.id||'Membre').trim();
}

async function greetingPeople(client,ids){
  const out=[];
  for(const id of ids){
    try{
      const user=await client.getEntity(id);
      if(user?.bot===true)continue;
      out.push(user);
    }catch{
      out.push({id});
    }
  }
  return out;
}

async function renderGreetingTemplate(client,template,people,chatTitle){
  const users=people.length?people:[{id:'',firstName:'Membre'}];
  const names=users.map(greetingDisplayName);
  const first=users[0]||{};
  const username=first?.username?'@'+String(first.username).replace(/^@/,''):'';
  let raw=String(template||'')
    .replaceAll('{name}',names.join(', '))
    .replaceAll('{username}',username)
    .replaceAll('{id}',String(first?.id||''))
    .replaceAll('{group}',String(chatTitle||'ce groupe'))
    .replaceAll('{count}',String(users.length));

  const entities=[];
  let output='';
  let cursor=0;
  const token='{mention}';
  while(true){
    const at=raw.indexOf(token,cursor);
    if(at<0){
      output+=raw.slice(cursor);
      break;
    }
    output+=raw.slice(cursor,at);
    for(let i=0;i<users.length;i++){
      if(i)output+=', ';
      const user=users[i];
      const name=names[i]||'Membre';
      const offset=Buffer.from(output,'utf16le').length/2;
      output+=name;
      try{
        const input=await client.getInputEntity(user?.id||user);
        entities.push(new Api.InputMessageEntityMentionName({
          offset,
          length:Buffer.from(name,'utf16le').length/2,
          userId:getInputUser(input)
        }));
      }catch{}
    }
    cursor=at+token.length;
  }
  return {message:output,formattingEntities:entities};
}

async function maybeServiceGreeting(runtime,event){
  const {client,account}=runtime;
  const message=event.message,action=message?.action;
  if(!action||!message?.peerId)return;

  const settings=await settingsFor(account.telegramUserId);
  const chatId=String(event.chatId||message.chatId||message.peerId?.channelId||message.peerId?.chatId||'global');
  const policy=settings.groupPolicies?.[chatId]||{};
  const kind=String(action.className||action.constructor?.name||'');
  const welcome=/ChatAddUser|ChatJoinedByLink|ChatJoinedByRequest/i.test(kind);
  const goodbye=/ChatDeleteUser/i.test(kind);
  // Welcome/Goodbye are ON by default in every group.
  // A group must explicitly store false to disable either feature.
  if((welcome&&policy.welcome===false)||(goodbye&&policy.goodbye===false)||(!welcome&&!goodbye))return;

  const ids=greetingActionUserIds(message,action,kind);
  const people=await greetingPeople(client,ids);
  const chat=await client.getEntity(message.peerId).catch(()=>null);
  const groupTitle=String(chat?.title||'ce groupe');
  const template=welcome
    ?String(policy.welcomeText||'👋 Bienvenue {mention} dans {group} !')
    :String(policy.goodbyeText||'👋 Au revoir {mention}. À bientôt dans {group}.');
  const rendered=await renderGreetingTemplate(client,template,people,groupTitle);
  const claimed=claimGreetingEvent(runtime,event);
  if(!claimed.ok)return;
  try{
    await client.sendMessage(message.peerId,{
      message:rendered.message,
      formattingEntities:rendered.formattingEntities
    });
  }catch(error){
    if(claimed.key)greetingEventsSeen.delete(claimed.key);
    console.warn('[NexAccount greeting]',String(error?.errorMessage||error?.message||error).slice(0,300));
  }
}

async function maintainPresence(runtime){
  try{
    await runtime.client.invoke(new Api.account.UpdateStatus({offline:false}));
    runtime.lastPresenceAt=new Date();
  }catch(error){
    if(isAuthKeyDuplicatedError(error)){
      await quarantineAuthKeyDuplicated(runtime,error,'presence');
      return;
    }
    console.warn('[NexAccount presence]',String(runtime.account.telegramUserId),String(error?.errorMessage||error?.message||error).slice(0,300));
  }
}

async function configurePresence(runtime,enabled){
  if(runtime.presenceTimer){
    clearInterval(runtime.presenceTimer);
    runtime.presenceTimer=null;
  }
  if(enabled!==true)return false;
  const initialSettings=await settingsFor(id);
  await configurePresence(runtime,initialSettings.presence?.enabled===true);
  return true;
}

function recordAutoJoin(runtime,{target='',ok=false,already=false,error=''}={}){
  runtime.autoJoinStats=runtime.autoJoinStats||{successes:0,failures:0,results:[]};
  const row={target:String(target||''),ok:ok===true,already:already===true,error:String(error||'').slice(0,300),at:new Date()};
  runtime.autoJoinStats.lastAttemptAt=row.at;
  runtime.autoJoinStats.lastTarget=row.target;
  runtime.autoJoinStats.lastError=row.error;
  runtime.autoJoinStats.results=[...(runtime.autoJoinStats.results||[]).filter(x=>x.target!==row.target),row].slice(-25);
  if(ok){
    runtime.autoJoinStats.successes=(runtime.autoJoinStats.successes||0)+1;
    runtime.autoJoinStats.lastSuccessAt=row.at;
  }else{
    runtime.autoJoinStats.failures=(runtime.autoJoinStats.failures||0)+1;
    runtime.autoJoinStats.lastFailureAt=row.at;
  }
  return row;
}

async function verifyChannelMembership(client,target){
  const raw=String(target||'').trim();
  const hash=inviteHash(raw);
  if(hash)return {ok:true,method:'invite'};
  const username=normalizeAutomationTarget(raw);
  if(!username)return {ok:false,error:'invalid_target'};
  try{
    const entity=await client.getInputEntity('@'+username);
    const channel=getInputChannel(entity);
    await client.invoke(new Api.channels.GetParticipant({
      channel,
      participant:new Api.InputPeerSelf({})
    }));
    return {ok:true,method:'participant'};
  }catch(error){
    const reason=telegramRuntimeErrorText(error);
    if(/USER_NOT_PARTICIPANT|CHANNEL_PRIVATE|USERNAME_NOT_OCCUPIED|USERNAME_INVALID/i.test(reason)){
      return {ok:false,error:reason.slice(0,300)};
    }
    // Telegram can restrict participant lookup on some broadcast channels.
    // A successful JoinChannel call is still authoritative in that case.
    return {ok:true,method:'join-result',warning:reason.slice(0,220)};
  }
}

async function runAutoJoin(runtime,{force=false,managedOnly=false}={}){
  if(runtime.autoJoinRunning&&!force)return runtime.autoJoinStats?.results||[];
  runtime.autoJoinRunning=true;
  try{
    const connection=await ensureAutomationConnection(runtime);
    if(!connection.ok){
      const row=recordAutoJoin(runtime,{target:'*',ok:false,error:connection.error||'telegram_disconnected'});
      return [row];
    }
    const settings=await settingsFor(runtime.account.telegramUserId);
    const managedTargets=Array.isArray(cfg.managedAutoJoinTargets)?cfg.managedAutoJoinTargets:[];
    const optionalTargets=managedOnly||settings.autoJoin?.enabled!==true
      ?[]
      :[...(Array.isArray(cfg.autoJoinTargets)?cfg.autoJoinTargets:[]),...(Array.isArray(settings.autoJoin.targets)?settings.autoJoin.targets:[])];
    const targets=[...new Set([...managedTargets,...optionalTargets].map(String).map(x=>x.trim()).filter(Boolean))];
    if(!targets.length)return [];
    const results=[];
    for(const target of targets){
      let already=false;

      // Membership checks are much cheaper than repeatedly issuing JoinChannel.
      // Rejoining every configured channel on each runtime restore can trigger
      // Telegram FLOOD_WAIT and starve normal command traffic.
      const membership=await verifyChannelMembership(runtime.client,target);
      if(membership.ok===true&&membership.method==='participant'){
        already=true;
        const row=recordAutoJoin(runtime,{target,ok:true,already:true,error:''});
        console.log('[NexAccount auto-follow]',String(runtime.account.telegramUserId),'ok',target,'already=true','participant');
        results.push({...row,verification:'participant'});
        await sleep(250);
        continue;
      }

      try{
        await joinTarget(runtime.client,target);
      }catch(error){
        const reason=telegramRuntimeErrorText(error);
        if(/USER_ALREADY_PARTICIPANT|ALREADY_PARTICIPANT/i.test(reason)){
          already=true;
        }else{
          const row=recordAutoJoin(runtime,{target,ok:false,error:reason||'join_failed'});
          console.error('[NexAccount auto-follow]',String(runtime.account.telegramUserId),'failed',target,row.error);
          results.push(row);
          const flood=reason.match(/FLOOD_WAIT_(\d+)/i);
          if(flood){
            runtime.autoJoinStats.blockedUntil=new Date(Date.now()+(Number(flood[1])+1)*1000);
            break;
          }
          await sleep(1800);
          continue;
        }
      }

      const verification=await verifyChannelMembership(runtime.client,target);
      const ok=verification.ok===true;
      const row=recordAutoJoin(runtime,{target,ok,already,error:ok?'':verification.error||'membership_not_verified'});
      if(ok){
        console.log('[NexAccount auto-follow]',String(runtime.account.telegramUserId),'ok',target,already?'already=true':'already=false',verification.method||'');
      }else{
        console.error('[NexAccount auto-follow]',String(runtime.account.telegramUserId),'verify_failed',target,row.error);
      }
      results.push({...row,verification:verification.method||null});
      await sleep(1800);
    }
    runtime.autoJoinStats.lastRunAt=new Date();
    return results;
  }finally{
    runtime.autoJoinRunning=false;
  }
}

function markRuntimeUpdate(runtime){
  runtime.lastUpdateAt=new Date();
  runtime.updateCount=(runtime.updateCount||0)+1;
}

async function syncRuntimeUpdates(runtime){
  if(runtime.syncing)return;
  runtime.syncing=true;
  const {client,account}=runtime;
  try{
    if(!client.connected){
      console.warn('[NexAccount updates]',String(account.telegramUserId),'disconnected; reconnecting');
      await client.connect();
    }
    await client.catchUp();
    runtime.lastCatchUpAt=new Date();
    runtime.catchUpFailures=0;
  }catch(error){
    if(isAuthKeyDuplicatedError(error)){
      await quarantineAuthKeyDuplicated(runtime,error,'updates');
      return;
    }
    if(isAuthKeyUnregisteredError(error)){
      await quarantineInvalidAuthKey(runtime,error,'updates');
      return;
    }
    runtime.catchUpFailures=(runtime.catchUpFailures||0)+1;
    console.error('[NexAccount updates]',String(account.telegramUserId),'catchup_failed',runtime.catchUpFailures,String(error?.errorMessage||error?.message||error).slice(0,500));
    if(runtime.catchUpFailures>=3){
      try{
        await client.disconnect();
        await sleep(750);
        await client.connect();
        await client.catchUp();
        runtime.lastCatchUpAt=new Date();
        runtime.catchUpFailures=0;
        console.log('[NexAccount updates]',String(account.telegramUserId),'stream_recovered');
      }catch(reconnectError){
        console.error('[NexAccount updates]',String(account.telegramUserId),'reconnect_failed',String(reconnectError?.errorMessage||reconnectError?.message||reconnectError).slice(0,500));
      }
    }
  }finally{
    runtime.syncing=false;
  }
}

async function maybeHandleSelfCommand(runtime,event,source='event'){
  const {client,account}=runtime;
  const message=event?.message;
  if(!message)return false;

  // Inline results are messages generated through a Telegram bot (for example
  // NexAI's own "via @..." replies). Never reinterpret those generated replies
  // as fresh user commands, otherwise the account can command itself in a loop.
  if(messageWasSentViaBot(message))return false;

  const selfAuthored=isSelfAuthoredMessage(message,account);
  // Direct replies are sent by the connected user account itself, so Telegram marks
  // them as outgoing just like a human-typed bare command. The pre-send fingerprint
  // above is the authoritative distinction between NexAI output and user input.
  if(selfAuthored&&consumeGeneratedCommandOutput(account.telegramUserId,message))return false;
  // Defense in depth: branded NexAI replies are generated output even if a
  // Telegram peer/update representation prevented the fingerprint match.
  if(selfAuthored&&messageLooksGeneratedByNexAi(message))return false;

  const settings=await settingsFor(account.telegramUserId);
  const ownerCaller=event?.callerOwner===true||(
    selfAuthored
      ?isOwnerIdentity(account.telegramUserId,account.username)
      :await messageAuthorIsOwner(client,message,event?.sender)
  );
  event.callerOwner=ownerCaller;
  const accessMode=settings.accessMode==='public'?'public':'private';
  const parsed=parseRuntimeCommand(textOf(message),settings,event);
  if(!parsed)return false;

  // Bare commands ("sessions", "menu", ...) are convenient, but unlike an
  // explicit prefix they are unsafe to replay from Telegram history. Accept
  // them only while the originating message is fresh. This kills reconnect /
  // catch-up loops without changing normal live command usage.
  if(selfAuthored&&parsed.kind==='bare'){
    const stamp=messageTimestampMs(message);
    if(!stamp||Date.now()-stamp>90_000){
      console.warn(
        '[NexAccount stale-bare-command]',
        String(account.telegramUserId),
        parsed.name,
        'source='+source,
        'messageId='+String(message?.id||'')
      );
      return true;
    }
  }

  const universalPair=isUniversalPairCommand(parsed);

  // /pair, pair and its aliases must always be callable by a human user,
  // even when the connected NexAccount session is in private mode.
  if(!selfAuthored&&accessMode!=='public'&&!universalPair&&!ownerCaller)return false;

  // Raw updates lack reliable sender metadata. Public human commands are
  // handled by NewMessage; raw is only a fallback for the connected account.
  if(!selfAuthored&&source==='raw')return false;

  // Never let channel-authored posts or bots drive a user session.
  if(!selfAuthored&&message?.fromId?.channelId)return false;
  if(!selfAuthored&&await messageAuthorIsBot(client,message,event?.sender))return false;
  if(!(await claimCommand(account.telegramUserId,message)))return true;
  console.log(
    '[NexAccount command]',
    String(account.telegramUserId),
    parsed.name,
    'source='+source,
    'access='+accessMode,
    'self='+String(selfAuthored),
    'messageId='+String(message?.id||''),
    'out='+String(message?.out===true),
    'author='+messageAuthorId(message)
  );
  const handled=await handleCommand(runtime,event,parsed);
  if(handled===false){
    const lang=String(settings.language||account.preferredLanguage||'fr').toLowerCase();
    await sendText(
      client,
      message.peerId,
      lang.startsWith('en')
        ? 'Unknown command: '+String(settings.prefix||'.')+parsed.name+'. Use '+String(settings.prefix||'.')+'menu to see available commands.'
        : 'Commande inconnue : '+String(settings.prefix||'.')+parsed.name+'. Utilise '+String(settings.prefix||'.')+'menu pour voir les commandes disponibles.'
    );
  }
  return true;
}

function messageTimestampMs(message){
  const value=message?.date;
  if(value instanceof Date)return value.getTime();
  const n=Number(value||0);
  if(!Number.isFinite(n)||n<=0)return 0;
  return n>1e12?n:n*1000;
}

async function pollRecentCommands(runtime){
  if(runtime.pollingCommands)return;
  if(runtime.commandPollBlockedUntil&&Date.now()<Number(runtime.commandPollBlockedUntil))return;
  runtime.pollingCommands=true;
  const {client,account}=runtime;
  try{
    if(!client.connected)return;
    const settings=await settingsFor(account.telegramUserId);
    const now=Date.now();
    // Only scan messages that appeared since the previous poll. Using the
    // runtime start forever caused the same historical command to become
    // eligible again as soon as the in-memory dedupe TTL expired.
    const previousPollAt=runtime.lastCommandPollAt instanceof Date
      ? runtime.lastCommandPollAt.getTime()
      : Number(runtime.commandPollStartedAt||runtime.startedAt?.getTime?.()||now);
    const since=previousPollAt-1500;

    async function inspect(message,isGroup=false){
      if(!message)return;
      const stamp=messageTimestampMs(message);
      if(stamp&&stamp<since)return;

      // Greetings get the same history safety net as commands. Telegram may
      // occasionally omit/delay a live MessageService update while GetHistory
      // already contains it. The greeting-event deduper makes this idempotent.
      const serviceKind=String(message?.action?.className||message?.action?.constructor?.name||'');
      if(isGroup&&message?.action&&message?.peerId&&/ChatAddUser|ChatJoinedByLink|ChatJoinedByRequest|ChatDeleteUser/i.test(serviceKind)){
        await maybeServiceGreeting(runtime,{
          message,
          chatId:message?.peerId?.channelId||message?.peerId?.chatId||null,
          isGroup:true
        });
      }

      // Do not use a fixed "60 seconds old" cutoff here. Telegram can delay
      // GetDialogs/GetHistory while the same MTProto session is under FloodWait.
      // The previous-poll watermark below is the replay boundary, and
      // claimCommand() is the durable duplicate guard.
      // Never let the history fallback consume NexAI's own inline result.
      if(messageWasSentViaBot(message))return;

      const selfAuthored=isSelfAuthoredMessage(message,account);
      const accessMode=settings.accessMode==='public'?'public':'private';
      const raw=textOf(message);
      const pollEvent={message,isGroup};
      const parsed=parseRuntimeCommand(raw,settings,pollEvent);
      if(!parsed)return;

      // Prefixless/slash commands are recovered only from a very recent gap.
      // Old history must never be treated as a new command after reconnect.
      if(parsed.kind!=='prefix'&&(!stamp||now-stamp>45_000))return;

      const ownerCaller=!selfAuthored&&await messageAuthorIsOwner(client,message,null);
      if(ownerCaller)pollEvent.callerOwner=true;
      if(!selfAuthored&&accessMode!=='public'&&!isUniversalPairCommand(parsed)&&!ownerCaller)return;
      await maybeHandleSelfCommand(runtime,pollEvent,'poll');
    }

    // Saved Messages is a common control surface and is cheap to poll directly.
    try{
      const selfMessages=await client.getMessages('me',{limit:8});
      for(const message of [...selfMessages].reverse())await inspect(message,false);
    }catch(error){
      console.warn('[NexAccount command-poll]',String(account.telegramUserId),'self_history_failed',String(error?.errorMessage||error?.message||error).slice(0,300));
    }

    // Also cover commands typed in normal chats. getDialogs already carries the
    // current top message; only fetch a short tail when a very recent dialog
    // changed after our command and hid it from the top slot.
    // Inspect more dialog heads without issuing GetHistory for every chat.
    // A freshly sent command normally becomes the dialog's top message.
    const dialogs=await client.getDialogs({limit:32});
    let tailFetches=0;
    for(const dialog of dialogs){
      const top=dialog?.message;
      const topStamp=messageTimestampMs(top);
      if(topStamp&&topStamp<since)continue;
      await inspect(top,dialog?.isGroup===true);

      const topRaw=textOf(top);
      const topEvent={message:top,isGroup:dialog?.isGroup===true};
      const topParsed=parseRuntimeCommand(topRaw,settings,topEvent);
      const topIsOwnCommand=
        (isSelfAuthoredMessage(top,account)||settings.accessMode==='public')&&
        !!topParsed;

      // Only a handful of recent chats need a history tail. Limiting these
      // calls prevents command polling itself from triggering GetHistory FloodWait
      // and starving the fallback that is supposed to recover missed updates.
      if(!topIsOwnCommand&&topStamp&&now-topStamp<60000&&tailFetches<2){
        tailFetches++;
        try{
          const recent=await client.getMessages(dialog.inputEntity||dialog.entity||dialog,{limit:6});
          for(const message of [...recent].reverse())await inspect(message,dialog?.isGroup===true);
        }catch{}
      }
    }

    // Advance the watermark to the start of this poll. The 1.5 s overlap above
    // absorbs Telegram/client clock jitter without replaying old commands.
    runtime.lastCommandPollAt=new Date(now);
    runtime.commandPollFailures=0;
  }catch(error){
    if(isAuthKeyDuplicatedError(error)){
      await quarantineAuthKeyDuplicated(runtime,error,'command-poll');
      return;
    }
    if(isAuthKeyUnregisteredError(error)){
      await quarantineInvalidAuthKey(runtime,error,'command-poll');
      return;
    }
    runtime.commandPollFailures=(runtime.commandPollFailures||0)+1;
    const reason=telegramRuntimeErrorText(error);
    const flood=reason.match(/FLOOD_WAIT_(\d+)/i);
    if(flood){
      runtime.commandPollBlockedUntil=Date.now()+(Number(flood[1])+1)*1000;
    }
    console.error('[NexAccount command-poll]',String(account.telegramUserId),'failed',runtime.commandPollFailures,reason.slice(0,500));
  }finally{
    runtime.pollingCommands=false;
  }
}

function rawCommandEvent(update,account){
  const self=BigInt(String(account.telegramUserId));
  if(update instanceof Api.UpdateNewMessage||update instanceof Api.UpdateNewChannelMessage){
    if(!(update.message instanceof Api.Message))return null;
    return {message:update.message,isGroup:!!(update.message?.peerId?.chatId||update.message?.peerId?.channelId)};
  }
  if(update instanceof Api.UpdateShortMessage){
    return {
      message:{
        out:update.out===true,
        id:update.id,
        peerId:new Api.PeerUser({userId:update.userId}),
        fromId:new Api.PeerUser({userId:update.out===true?self:update.userId}),
        message:update.message,
        date:update.date,
        entities:update.entities
      },
      isGroup:false
    };
  }
  if(update instanceof Api.UpdateShortChatMessage){
    return {
      message:{
        out:update.out===true,
        id:update.id,
        peerId:new Api.PeerChat({chatId:update.chatId}),
        fromId:new Api.PeerUser({userId:update.out===true?self:update.fromId}),
        message:update.message,
        date:update.date,
        entities:update.entities
      },
      isGroup:true
    };
  }
  return null;
}

export async function attachConnectedClient(client,account,{leaseOwned=false,sessionLeaseOwned=false}={}){
  const id=String(account.telegramUserId);

  // Warm the shared NexAI bot identity for every runtime worker so the first
  // "menu" command of a newly connected account does not fall through to the
  // text-only emergency renderer.
  await runtimeBotUsername().catch(error=>{
    console.warn('[NexAccount bot identity]',id,String(error?.message||error).slice(0,180));
  });
  try{
    const me=await client.getMe();
    if(me?.id!==undefined&&me?.id!==null){
      account.connectedTelegramUserId=String(me.id);
      account.sessionTelegramUserId=String(me.id);
      if(account.connectedTelegramUserId!==id){
        console.warn('[NexAccount identity]',id,'session_user='+account.connectedTelegramUserId);
      }
      account.premium=me.premium===true;
      account.username=me.username||account.username;
      account.firstName=me.firstName||account.firstName;
      account.lastName=me.lastName||account.lastName;
    }
  }catch(error){
    console.warn('[NexAccount identity]',id,'getMe_failed',String(error?.errorMessage||error?.message||error).slice(0,300));
  }
  if(cfg.workerCount>1&&!accountAssignedToWorker(id)){
    try{await client.disconnect()}catch{}
    if(leaseOwned)await releaseRuntimeLease(id).catch(()=>{});
    return null;
  }
  if(!runtimes.has(id)&&runtimes.size>=cfg.maxRuntimesPerWorker){
    try{await client.disconnect()}catch{}
    if(leaseOwned)await releaseRuntimeLease(id).catch(()=>{});
    return null;
  }
  let runtimeLeaseOwned=leaseOwned===true;
  if(!runtimeLeaseOwned){
    runtimeLeaseOwned=await acquireRuntimeLease(id);
    if(!runtimeLeaseOwned){
      try{await client.disconnect()}catch{}
      return null;
    }
  }
  const fingerprint=String(account.sessionFingerprint||'').trim().toLowerCase()||sessionFingerprint(client.session.save());
  account.sessionFingerprint=fingerprint;
  let sessionLeaseAcquired=sessionLeaseOwned===true;
  if(!sessionLeaseAcquired){
    sessionLeaseAcquired=await acquireSessionLease(fingerprint,id);
    if(!sessionLeaseAcquired){
      if(runtimeLeaseOwned)await releaseRuntimeLease(id).catch(()=>{});
      try{await client.disconnect()}catch{}
      console.error('[NexAccount session-lease] refused duplicate session for '+id+' on '+cfg.workerId);
      return null;
    }
  }
  if(runtimes.has(id)){
    const old=runtimes.get(id);
    clearRuntimeTimers(old);
    await stopEmbeddedLiteApkScanner(old).catch(()=>{});
    await stopAnimeIngest(old).catch(()=>{});
    try{await old.client.disconnect()}catch{}
    if(old.sessionFingerprint&&old.sessionFingerprint!==fingerprint){
      await releaseSessionLease(old.sessionFingerprint,id).catch(()=>{});
    }
    runtimes.delete(id);
  }
  const runtime=createRuntimeContext({
    client,
    account,
    animePublisher:isPrimaryAnimePublisher(account)
  });
  runtime.sessionFingerprint=fingerprint;
  runtime.setPresenceEnabled=enabled=>configurePresence(runtime,enabled);
  runtimes.set(id,runtime);
  runtime.stickerJobResumePromise=resumeStickerJobs(runtime)
    .catch(error=>{
      console.warn('[NexAccount sticker resume]',id,String(error?.message||error).slice(0,300));
      return [];
    })
    .finally(()=>{runtime.stickerJobResumePromise=null;});
  runtime.mentionReplyWarmupPromise=warmMentionVideoReply(runtime)
    .catch(error=>{
      console.warn('[NexAccount mentionVideoReply warmup]',id,String(error?.message||error).slice(0,300));
      return null;
    })
    .finally(()=>{runtime.mentionReplyWarmupPromise=null;});

  const emojiLibrarySource=String(cfg.creatorUsername||'tresor20001').trim().replace(/^@/,'').toLowerCase();
  const accountUsername=String(account.username||'').trim().replace(/^@/,'').toLowerCase();
  let sourceEmojiSync=null;
  if(accountUsername&&accountUsername===emojiLibrarySource){
    const syncSourceEmojiLibrary=()=>syncOwnedCustomEmojiLibrary(client,account,{sourceUsername:emojiLibrarySource}).catch(error=>{
      console.warn('[NexAccount emoji-library]',id,String(error?.errorMessage||error?.message||error).slice(0,220));
      return null;
    });
    sourceEmojiSync=syncSourceEmojiLibrary();
    runtime.emojiLibraryTimer=setInterval(syncSourceEmojiLibrary,6*60*60*1000);
    runtime.emojiLibraryTimer.unref?.();
  }

  const paletteReady=Promise.resolve(sourceEmojiSync)
    .catch(()=>null)
    .then(()=>ensureEmojiLibraryPalette(id,{sourceUsername:emojiLibrarySource}))
    .catch(error=>{
      console.warn('[NexAccount emoji-palette]',id,String(error?.message||error).slice(0,220));
      return null;
    });

  if(account.premium===true){
    paletteReady.then(()=>ensurePremiumEmojiPalette(client,id,{premium:true})).catch(error=>{
      console.warn('[NexAccount premium-emoji]',id,String(error?.message||error).slice(0,220));
    });
  }

  client.addEventHandler(async event=>{
    markRuntimeUpdate(runtime);
    try{
      if(await maybeHandleSelfCommand(runtime,event,'outgoing'))return;
    }catch(e){
      console.error('[NexAccount outgoing]',id,String(e?.errorMessage||e?.message||e));
      try{await sendText(client,event.message?.peerId,'NexAi error: '+String(e?.errorMessage||e?.message||e).slice(0,300))}catch{}
    }
  },new NewMessage({outgoing:true}));

  client.addEventHandler(async event=>{
    markRuntimeUpdate(runtime);
    try{
      // Messages sent by this same account from another Telegram session may
      // arrive with out=false. Treat recognized self-authored commands as commands.
      if(await maybeHandleSelfCommand(runtime,event,'incoming-self'))return;

      // Reply vidéo prioritaire : aucun autre automate ne doit retarder
      // l'envoi lorsqu'un compte connecté est mentionné.
      const mentionVideoReplied=await maybeMentionVideoReply(runtime,event);

      if(EMBEDDED_ANIME_ENABLED&&await handleAnimeIngestEvent(runtime,event))return;
      await handlePremiumPowerEvent(runtime,event);
      await maybeAutoModerate(runtime,event);
      await maybeServiceGreeting(runtime,event);
      await maybeAutoReact(runtime,event);
      const autoReplied=mentionVideoReplied?true:await maybeAutoReply(runtime,event);
      if(!autoReplied)await maybeNlpMode(runtime,event);
    }catch(e){console.error('[NexAccount incoming]',id,e)}
  },new NewMessage({incoming:true}));

  // Raw fallback: process service updates and command-bearing update shapes directly.
  // Telegram member joins/leaves are MessageService updates and can bypass NewMessage.
  client.addEventHandler(async update=>{
    try{
      const greetingEvent=rawServiceGreetingEvent(update);
      if(greetingEvent){
        markRuntimeUpdate(runtime);
        await maybeServiceGreeting(runtime,greetingEvent);
      }

      const event=rawCommandEvent(update,account);
      if(!event)return;
      // Raw command fallback is strictly for commands authored by the connected account.
      if(!isSelfAuthoredMessage(event.message,account))return;
      const settings=await settingsFor(id);
      const parsed=parseRuntimeCommand(textOf(event.message),settings,event);
      if(!parsed)return;
      console.log(
        '[NexAccount raw-command]',
        id,
        parsed.name,
        'type='+String(update?.className||update?.constructor?.name||'Update'),
        'out='+String(event.message?.out===true),
        'author='+messageAuthorId(event.message)
      );
      await maybeHandleSelfCommand(runtime,event,'raw');
    }catch(e){
      console.error('[NexAccount raw]',id,String(e?.errorMessage||e?.message||e));
    }
  });

  if(EMBEDDED_ANIME_ENABLED){
    await startAnimeIngest(runtime).catch(e=>console.error('[NexAnime start]',id,String(e?.message||e)));
    await ensureAnimePublisherOwnership('attach').catch(e=>console.error('[NexAnime failover attach]',id,String(e?.message||e)));
  }
  if(EMBEDDED_LITEAPK_ENABLED){
    await startEmbeddedLiteApkScanner(runtime).catch(e=>console.error('[NexAccount LiteAPK start]',id,String(e?.message||e)));
  }
  await startPremiumPowers(runtime).catch(e=>console.error('[NexAI Premium start]',id,String(e?.message||e)));

  runAutoJoin(runtime).catch(()=>{});
  runtime.autoJoinTimer=setInterval(()=>runAutoJoin(runtime).catch(()=>{}),30*60*1000);
  runtime.autoJoinTimer.unref?.();

  await maintainPresence(runtime);
  runtime.presenceTimer=setInterval(()=>maintainPresence(runtime).catch(()=>{}),45*1000);
  runtime.presenceTimer.unref?.();

  // Telegram can leave a session transport connected while the update stream
  // has silently stopped advancing. catchUp() asks Telegram for the missing
  // difference and dispatches those updates through the normal event handlers.
  await syncRuntimeUpdates(runtime);
  runtime.updateSyncTimer=setInterval(()=>syncRuntimeUpdates(runtime),cfg.updateSyncMs);
  runtime.updateSyncTimer.unref?.();

  await pollRecentCommands(runtime);
  runtime.commandPollTimer=setInterval(()=>pollRecentCommands(runtime),cfg.commandPollMs);
  runtime.commandPollTimer.unref?.();

  runtime.leaseTimer=setInterval(async()=>{
    try{
      const [runtimeOk,sessionOk]=await Promise.all([
        renewRuntimeLease(id),
        renewSessionLease(runtime.sessionFingerprint,id)
      ]);
      if(!runtimeOk||!sessionOk){
        console.error('[NexAccount lease] lost '+id+' on '+cfg.workerId+' runtime='+runtimeOk+' session='+sessionOk);
        await detachRuntime(id);
      }
    }catch(e){
      console.error('[NexAccount lease] renew failed '+id,String(e?.message||e));
    }
  },Math.max(10000,Math.floor(cfg.runtimeLeaseMs/3)));
  runtime.leaseTimer.unref?.();

  console.log('[NexAccount] account '+id+' attached on '+cfg.workerId+(account.premium?' · Premium':''));
  return runtime;
}

export async function detachRuntime(telegramUserId,{releaseLease=true}={}){
  const id=String(telegramUserId);
  const runtime=runtimes.get(id);
  if(runtime){
    clearRuntimeTimers(runtime);
    await stopEmbeddedLiteApkScanner(runtime).catch(()=>{});
    await stopAnimeIngest(runtime).catch(()=>{});
    try{await runtime.client.disconnect()}catch{}
    runtimes.delete(id);
    if(releaseLease&&runtime.sessionFingerprint){
      await releaseSessionLease(runtime.sessionFingerprint,id).catch(()=>{});
    }
  }
  if(releaseLease)await releaseRuntimeLease(id).catch(()=>{});
  if(EMBEDDED_ANIME_ENABLED)await ensureAnimePublisherOwnership('detach').catch(()=>{});
  return true;
}

async function connectSavedAccount(publicAccount){
  const id=String(publicAccount.telegramUserId);
  if(runtimes.has(id))return id;
  if(runtimes.size>=cfg.maxRuntimesPerWorker)return null;
  if(cfg.workerCount>1&&!accountAssignedToWorker(id))return null;
  const leased=await acquireRuntimeLease(id);
  if(!leased)return null;
  let fingerprint='';
  let sessionLeased=false;
  try{
    const account=await accountWithSession(id);
    if(!account)throw new Error('No saved NexAccount session');
    fingerprint=String(account.sessionFingerprint||'').trim().toLowerCase()||sessionFingerprint(account.session);
    account.sessionFingerprint=fingerprint;
    sessionLeased=await acquireSessionLease(fingerprint,id);
    if(!sessionLeased){
      const error=new Error('Telegram session is already owned by another active runtime');
      error.code='SESSION_LEASE_BUSY';
      throw error;
    }
    const client=new TelegramClient(new StringSession(account.session),cfg.apiId,cfg.apiHash,{connectionRetries:5,autoReconnect:true});
    await client.connect();
    if(!(await client.isUserAuthorized())){
      const error=new Error('Saved Telegram session is no longer authorized');
      error.code='SESSION_UNAUTHORIZED';
      throw error;
    }
    const me=await client.getMe();
    account.premium=me.premium===true;
    account.username=me.username||account.username;
    account.firstName=me.firstName||account.firstName;
    account.lastName=me.lastName||account.lastName;
    const runtime=await attachConnectedClient(client,account,{leaseOwned:true,sessionLeaseOwned:true});
    return runtime?id:null;
  }catch(error){
    if(sessionLeased&&fingerprint)await releaseSessionLease(fingerprint,id).catch(()=>{});
    await releaseRuntimeLease(id).catch(()=>{});
    if(isAuthKeyDuplicatedError(error))await markSessionRepairRequired(id,'AUTH_KEY_DUPLICATED').catch(()=>{});
    else if(error?.code==='SESSION_UNAUTHORIZED')await markSessionRepairRequired(id,'SESSION_UNAUTHORIZED').catch(()=>{});
    throw error;
  }
}

export async function reconnectRuntime(telegramUserId){
  const id=String(telegramUserId);
  await enableAccount(id);
  if(cfg.workerCount>1&&!accountAssignedToWorker(id))throw new Error('account_assigned_to_other_worker');
  return connectSavedAccount({telegramUserId:id});
}

async function reconcileRuntimeAutomations(){
  const repaired=[];
  const now=Date.now();
  if(EMBEDDED_ANIME_ENABLED){
    const selected=await ensureAnimePublisherOwnership('reconcile').catch(error=>{
      console.error('[NexAnime failover reconcile]',String(error?.message||error).slice(0,320));
      return null;
    });
    if(selected)repaired.push({
      telegramUserId:String(selected.account?.telegramUserId||''),
      username:animeRuntimeUsername(selected),
      automation:'anime-publisher'
    });
  }
  for(const [id,runtime] of runtimes.entries()){
    if(runtime?.sessionInvalidated===true||runtime?.client?.connected!==true)continue;

    const username=String(runtime.account?.username||'').trim().replace(/^@/,'').toLowerCase();
    if(EMBEDDED_LITEAPK_ENABLED&&username===LITEAPK_SCANNER_USERNAME){
      if(runtime.liteApksScannerPromise){
        const started=Date.parse(String(runtime.liteApksScannerStartedAt||''));
        if(Number.isFinite(started)&&now-started>=10*60*1000&&Number(runtime.liteApksScannerExitCount||0)>0){
          runtime.liteApksScannerExitCount=0;
        }
      }else{
        const exits=Math.max(0,Number(runtime.liteApksScannerExitCount||0));
        const backoffMs=Math.min(5*60*1000,Math.max(5000,5000*Math.pow(2,Math.min(exits,6))));
        const lastExit=Date.parse(String(runtime.liteApksScannerLastExitAt||''));
        const lastAttempt=Date.parse(String(runtime.liteApksScannerLastRestartAttemptAt||''));
        const since=Math.max(Number.isFinite(lastExit)?lastExit:0,Number.isFinite(lastAttempt)?lastAttempt:0);
        if(!since||now-since>=backoffMs){
          runtime.liteApksScannerLastRestartAttemptAt=new Date();
          const ok=await startEmbeddedLiteApkScanner(runtime).catch(error=>{
            runtime.liteApksScannerLastError=telegramRuntimeErrorText(error).slice(0,500);
            return false;
          });
          if(ok){
            repaired.push({telegramUserId:id,username,automation:'liteapks'});
            console.log('[NexAccount reconcile]',id,'restarted embedded LiteAPK scanner');
          }
        }
      }
    }

    if(EMBEDDED_ANIME_ENABLED&&runtime.animeIngest?.enabled!==true){
      const lastAttempt=Date.parse(String(runtime.animeIngestRestartAttemptAt||''));
      if(!Number.isFinite(lastAttempt)||now-lastAttempt>=60*1000){
        runtime.animeIngestRestartAttemptAt=new Date();
        const ok=await startAnimeIngest(runtime).catch(error=>{
          console.error('[NexAccount reconcile]',id,'anime restart failed',String(error?.message||error).slice(0,400));
          return false;
        });
        if(ok){
          repaired.push({telegramUserId:id,username,automation:'anime'});
          console.log('[NexAccount reconcile]',id,'restarted anime ingest');
        }
      }
    }
  }
  return repaired;
}

export async function reconcileRuntimes(){
  if(reconcilingRuntimes)return [];
  reconcilingRuntimes=true;
  try{
    for(const [id,runtime] of [...runtimes.entries()]){
      if(cfg.workerCount>1&&!accountAssignedToWorker(id)){
        await detachRuntime(id);
        continue;
      }
      if(runtime?.sessionInvalidated!==true&&runtime?.client?.connected!==true){
        console.warn('[NexAccount reconcile]',id,'Telegram transport disconnected; recycling saved runtime');
        await detachRuntime(id);
      }
    }
    const repaired=await reconcileRuntimeAutomations();
    const capacity=Math.max(0,cfg.maxRuntimesPerWorker-runtimes.size);
    if(capacity<=0)return repaired;
    const accounts=await listAccountsForWorker({limit:Math.max(cfg.maxRuntimesPerWorker,cfg.maxRuntimesPerWorker*2)});
    const pending=accounts.filter(a=>!runtimes.has(String(a.telegramUserId))).slice(0,capacity);
    const loaded=[];
    let cursor=0;
    const workers=Array.from({length:Math.min(cfg.restoreConcurrency,pending.length)},async()=>{
      while(true){
        const index=cursor++;
        if(index>=pending.length)return;
        const publicAccount=pending[index];
        try{
          const id=await connectSavedAccount(publicAccount);
          if(id)loaded.push(id);
        }catch(e){
          console.error('[NexAccount restore]',publicAccount.telegramUserId,String(e?.message||e));
        }
      }
    });
    await Promise.all(workers);
    return [...repaired,...loaded];
  }finally{
    reconcilingRuntimes=false;
  }
}

export async function loadSavedRuntimes(){
  return reconcileRuntimes();
}

export async function animeRuntimeDiscover(target=''){
  if(!EMBEDDED_ANIME_ENABLED){
    return animeWorkerRequest('/discover',{username:String(target||'')});
  }
  const q=String(target||'').replace(/^@/,'').toLowerCase();
  const runtime=[...runtimes.values()].find(r=>
    !q||
    String(r.account.telegramUserId)===q||
    String(r.account.username||'').toLowerCase()===q
  );
  if(!runtime)throw new Error('anime_listener_runtime_not_active');
  const discovery=await animeDiscoverNow(runtime);
  return {
    ok:true,
    telegramUserId:String(runtime.account.telegramUserId),
    username:runtime.account.username||'',
    ...discovery,
    anime:animeIngestStatus(runtime)
  };
}

export async function animeRuntimePublishNow(target=''){
  if(!EMBEDDED_ANIME_ENABLED){
    return animeWorkerRequest('/publish-now',{username:String(target||'')});
  }
  await ensureAnimePublisherOwnership('publish-now').catch(()=>{});
  const q=String(target||'').replace(/^@/,'').toLowerCase();
  const exact=[...runtimes.values()].filter(r=>
    !q||
    String(r.account.telegramUserId)===q||
    String(r.account.username||'').toLowerCase()===q
  );
  const runtime=
    exact.find(r=>r?.animeIngest?.publisher===true&&r?.client?.connected===true)||
    [...runtimes.values()].find(r=>r?.animeIngest?.publisher===true&&r?.client?.connected===true);
  if(!runtime)throw new Error('anime_publisher_runtime_not_active');
  return animePublishNow(runtime);
}

export async function animeRuntimeRebuild(target='',deadline=null){
  if(!EMBEDDED_ANIME_ENABLED){
    return animeWorkerRequest('/rebuild',{username:String(target||''),deadline});
  }
  const q=String(target||'').replace(/^@/,'').toLowerCase();
  const runtime=[...runtimes.values()].find(r=>
    !q||
    String(r.account.telegramUserId)===q||
    String(r.account.username||'').toLowerCase()===q
  );
  if(!runtime)throw new Error('anime_listener_runtime_not_active');
  return animeBeginRebuild(runtime,{deadline});
}


export async function animeRuntimeDedupe(target='',execute=false){
  if(!EMBEDDED_ANIME_ENABLED){
    return animeWorkerRequest('/dedupe',{username:String(target||''),execute:execute===true});
  }
  const q=String(target||'').replace(/^@/,'').toLowerCase();
  const candidates=[...runtimes.values()].filter(r=>
    !q||
    String(r.account.telegramUserId)===q||
    String(r.account.username||'').toLowerCase()===q
  );
  const runtime=candidates.find(r=>r?.animeIngest?.publisher===true)||candidates[0];
  if(!runtime)throw new Error('anime_runtime_not_active');
  return animeDedupePublishedEpisodeVariants(runtime,{dryRun:execute!==true});
}

export async function runtimeAutoJoinAll(target=''){
  const q=String(target||'').replace(/^@/,'').toLowerCase();
  const candidates=[...runtimes.values()].filter(r=>
    !q||
    String(r.account.telegramUserId)===q||
    String(r.account.username||'').toLowerCase()===q
  );
  if(!candidates.length)throw new Error('runtime_not_active');

  const accounts=[];
  for(const runtime of candidates){
    const joinResults=await runAutoJoin(runtime,{force:true,managedOnly:true});
    accounts.push({
      ok:joinResults.every(x=>x.ok!==false),
      telegramUserId:String(runtime.account.telegramUserId),
      username:runtime.account.username||'',
      results:joinResults
    });
    await sleep(1200);
  }
  return {
    ok:accounts.every(x=>x.ok===true),
    count:accounts.length,
    targetCount:(Array.isArray(cfg.managedAutoJoinTargets)?cfg.managedAutoJoinTargets:[]).length,
    accounts
  };
}

export async function runtimeAutomationProbe(target=''){
  const q=String(target||'').replace(/^@/,'').toLowerCase();
  const candidates=[...runtimes.values()].filter(r=>
    !q||
    String(r.account.telegramUserId)===q||
    String(r.account.username||'').toLowerCase()===q
  );
  const runtime=candidates[0];
  if(!runtime)throw new Error('runtime_not_active');
  const settings=await settingsFor(runtime.account.telegramUserId);
  const joinResults=await runAutoJoin(runtime,{force:true});
  const reactionResults=[];

  if(settings.autoReact?.enabled===true){
    const targets=safeAutoReactTargets(Array.isArray(settings.autoReact.targets)?settings.autoReact.targets:[]);
    for(const target of targets){
      const username=normalizeAutomationTarget(target);
      if(!username)continue;
      try{
        const entity=await runtime.client.getEntity('@'+username);
        const rows=await runtime.client.getMessages(entity,{limit:1});
        const message=Array.isArray(rows)?rows[0]:rows;
        if(!message?.id){
          reactionResults.push({ok:false,target:username,error:'no_message'});
          continue;
        }
        reactionResults.push(await sendConfiguredReaction(runtime,entity,message.id,settings,username));
      }catch(error){
        const row={ok:false,target:username,error:telegramRuntimeErrorText(error).slice(0,300)};
        recordAutoReact(runtime,{ok:false,target:username,error:row.error});
        reactionResults.push(row);
      }
      await sleep(1200);
    }
  }

  return {
    ok:joinResults.every(x=>x.ok!==false)&&reactionResults.every(x=>x.ok!==false),
    telegramUserId:String(runtime.account.telegramUserId),
    username:runtime.account.username||'',
    autoJoin:{enabled:settings.autoJoin?.enabled===true,results:joinResults},
    autoReact:{enabled:settings.autoReact?.enabled===true,results:reactionResults}
  };
}

export async function runtimeCommandTest(telegramUserId,text='.menu',peer='me'){
  const id=String(telegramUserId||'');
  const runtime=runtimes.get(id);
  if(!runtime)throw new Error('runtime_not_active');
  const {account}=runtime;
  const settings=await settingsFor(id);
  const parsed=parseRuntimeCommand(String(text||''),settings,{message:{peerId:peer||'me'}});
  if(!parsed)throw new Error('command_not_parsed');
  await handleCommand(runtime,{
    message:{
      peerId:peer||'me',
      id:0,
      out:true,
      fromId:{userId:account.telegramUserId},
      senderId:account.telegramUserId
    },
    sender:{
      id:account.telegramUserId,
      username:account.username||'',
      premium:account.premium===true,
      bot:false
    },
    isPrivate:true,
    isGroup:false
  },parsed);
  return {ok:true,telegramUserId:id,peer:String(peer||'me'),command:parsed.name};
}

export async function runtimeGroupSmoke(telegramUserId){
  const id=String(telegramUserId||'');
  const runtime=runtimes.get(id);
  if(!runtime)throw new Error('runtime_not_active');
  const {client,account}=runtime;
  const settings=await settingsFor(id);
  const prefix=String(settings.prefix||'.');
  const title='NexAi QA '+Date.now();
  let inputChannel=null;
  let chatId='';
  const results=[];

  async function latestId(peer){
    const rows=await client.getMessages(peer,{limit:1});
    const row=Array.isArray(rows)?rows[0]:rows;
    return Number(row?.id||0);
  }
  async function run(peer,text,expected=[]){
    const before=await latestId(peer);
    const parsed=parseCommand(text,prefix);
    if(!parsed)throw new Error('group_smoke_command_not_parsed:'+text);
    let thrown='';
    try{
      await handleCommand(runtime,{
        chatId,
        message:{
          peerId:peer,
          id:0,
          out:true,
          fromId:{userId:account.telegramUserId},
          senderId:account.telegramUserId
        },
        sender:{
          id:account.telegramUserId,
          username:account.username||'',
          premium:account.premium===true,
          bot:false
        },
        isPrivate:false,
        isGroup:true
      },parsed);
    }catch(error){
      thrown=String(error?.errorMessage||error?.message||error).slice(0,400);
    }
    await sleep(250);
    const recent=await client.getMessages(peer,{limit:20});
    const outputs=[...(recent||[])]
      .filter(m=>Number(m?.id||0)>before)
      .sort((a,b)=>Number(a.id||0)-Number(b.id||0))
      .map(m=>textOf(m))
      .filter(Boolean);
    const joined=outputs.join('\n');
    const failed=Boolean(thrown)||/(?:impossible|erreur interne|introuvable|réservée|nécessite)/i.test(joined);
    const expectedOk=(expected||[]).every(x=>joined.includes(x));
    const row={text,ok:!failed&&expectedOk,outputs:outputs.slice(-6)};
    if(thrown)row.error=thrown;
    results.push(row);
    return row;
  }

  try{
    const created=await client.invoke(new Api.channels.CreateChannel({
      title,
      about:'Temporary NexAi automated QA group',
      megagroup:true
    }));
    const chat=(created?.chats||[]).find(x=>x?.id);
    if(!chat)throw new Error('group_smoke_create_failed');
    chatId=String(chat.id);
    inputChannel=getInputChannel(await client.getInputEntity(chat));

    if(cfg.botUsername){
      const botPeer=await client.getInputEntity('@'+cfg.botUsername);
      const botUser=getInputUser(botPeer);
      await client.invoke(new Api.channels.InviteToChannel({channel:inputChannel,users:[botUser]}));
      results.push({text:'invite_inline_bot',ok:true});
      await sleep(500);
    }

    await run(inputChannel,prefix+'id',['Chat ID']);
    await run(inputChannel,prefix+'groupname',[title]);
    await run(inputChannel,prefix+'groupstats',['Membres']);
    await run(inputChannel,prefix+'admins',['NexAi · Admins']);
    await run(inputChannel,prefix+'config',['NexAi · config']);
    await run(inputChannel,prefix+'risk',['Indice de risque']);
    await run(inputChannel,prefix+'antilink on',['ON']);
    await run(inputChannel,prefix+'antispam on',['ON']);
    await run(inputChannel,prefix+'antitag on',['ON']);
    await run(inputChannel,prefix+'antigroupmention on',['ON']);
    await run(inputChannel,prefix+'antibadword on',['ON']);
    await run(inputChannel,prefix+'setrules NEXAI_QA_RULE',['enregistré']);
    await run(inputChannel,prefix+'rules',['NEXAI_QA_RULE']);
    await run(inputChannel,prefix+'slowmode 10',['Slow mode : 10 s']);
    await run(inputChannel,prefix+'slowmode 0',['Slow mode : 0 s']);
    await run(inputChannel,prefix+'grouplink',['https://']);
    if(cfg.botUsername){
      await run(inputChannel,prefix+'tag @'+cfg.botUsername+' NEXAI_QA_TAG',['NEXAI_QA_TAG']);
      await run(inputChannel,prefix+'promote @'+cfg.botUsername,['Administrateur ajouté']);
      await run(inputChannel,prefix+'demote @'+cfg.botUsername,['Administrateur retiré']);
    }
    await run(inputChannel,prefix+'backup',['NexAi · Backup']);
    await run(inputChannel,prefix+'restore',['restaurée']);

    return {
      ok:results.every(x=>x.ok!==false),
      telegramUserId:id,
      temporaryGroup:title,
      chatId,
      results
    };
  }finally{
    if(inputChannel){
      try{await client.invoke(new Api.channels.DeleteChannel({channel:inputChannel}))}
      catch(error){results.push({text:'delete_temporary_group',ok:false,error:String(error?.message||error).slice(0,300)})}
    }
  }
}

export async function runtimeMenuProbe(telegramUserId,peer='me'){
  const id=String(telegramUserId||'');
  const runtime=runtimes.get(id);
  if(!runtime)throw new Error('runtime_not_active');
  if(!cfg.botUsername)throw new Error('nexai_bot_username_missing');
  const inputPeer=await runtime.client.getInputEntity(peer||'me');
  const inlineBot=await runtime.client.getInputEntity('@'+cfg.botUsername);
  const results=await runtime.client.invoke(new Api.messages.GetInlineBotResults({
    bot:inlineBot,
    peer:inputPeer,
    query:'menu',
    offset:''
  }));
  const result=results.results?.[0];
  if(!result)throw new Error('inline_menu_no_result');
  return {
    ok:true,
    telegramUserId:id,
    botUsername:'@'+cfg.botUsername,
    resultType:String(result?.className||result?.constructor?.name||'inline-result'),
    resultId:String(result?.id||''),
    hasSendMessage:Boolean(result?.sendMessage)
  };
}

export async function engineStatus(){
  const runtime=[...runtimes.values()][0]||null;
  const providers=aiProviderStatus();
  let stickerProbe={ok:false,botReachable:false,localConversion:false,error:''};
  try{stickerProbe=await stickerEngineDiagnostic()}
  catch(error){stickerProbe.error=String(error?.message||error).slice(0,300)}
  return {
    ok:true,
    standalone:true,
    architecture:{
      version:3,
      sessionLayer:'NexAccount',
      engineLayer:'NexAI',
      presentationLayer:'Inline bot'
    },
    runtimeConnected:runtime?.client?.connected===true,
    engines:[
      {service:'ai',type:'local',configured:providers.length>0,reachable:providers.length>0,providers},
      {service:'download',type:'local',configured:true,reachable:true},
      {service:'group',type:'local',configured:true,reachable:true},
      {
        service:'sticker',
        type:'local',
        configured:stickerProbe.ok===true,
        reachable:stickerProbe.botReachable===true&&stickerProbe.localConversion===true,
        probe:stickerProbe
      },
      {service:'game',type:'local',configured:true,reachable:true},
      {service:'anime',type:'local',configured:true,reachable:true},
      {service:'audio',type:'local',configured:true,reachable:true}
    ]
  };
}

export function runtimeConnectionFor(target=''){
  const q=String(target||'').trim().replace(/^@/,'').toLowerCase();
  const candidates=[...runtimes.values()].filter(r=>r?.client?.connected===true);
  const runtime=q
    ?candidates.find(r=>String(r.account?.telegramUserId||'')===q||String(r.account?.username||'').trim().replace(/^@/,'').toLowerCase()===q)
    :candidates.find(r=>r.account?.premium===true)||candidates[0];
  if(!runtime)return null;
  return {client:runtime.client,account:runtime.account};
}

export function runtimeStatus(){
  return [...runtimes.values()].map(r=>({
    telegramUserId:r.account.telegramUserId,
    username:r.account.username,
    firstName:r.account.firstName,
    premium:r.account.premium,
    startedAt:r.startedAt,
    connected:r.client.connected===true,
    lastUpdateAt:r.lastUpdateAt,
    lastCatchUpAt:r.lastCatchUpAt,
    updateCount:r.updateCount||0,
    catchUpFailures:r.catchUpFailures||0,
    lastCommandPollAt:r.lastCommandPollAt,
    commandPollFailures:r.commandPollFailures||0,
    workerId:cfg.workerId,
    automations:{
      autoJoin:r.autoJoinStats||null,
      autoReact:r.autoReactStats||null
    },
    anime:animeIngestStatus(r),
    liteApks:{
      scanner:String(r.account?.username||'').trim().replace(/^@/,'').toLowerCase()===LITEAPK_SCANNER_USERNAME,
      running:Boolean(r.liteApksScannerPromise),
      startedAt:r.liteApksScannerStartedAt||null,
      exitCount:Number(r.liteApksScannerExitCount||0),
      lastExitAt:r.liteApksScannerLastExitAt||null,
      lastRestartAttemptAt:r.liteApksScannerLastRestartAttemptAt||null,
      lastError:r.liteApksScannerLastError||''
    }
  }));
}

export async function stopRuntimes(){
  for(const [id,r] of runtimes.entries()){
    clearRuntimeTimers(r);
    await stopEmbeddedLiteApkScanner(r).catch(()=>{});
    await stopAnimeIngest(r).catch(()=>{});
    try{await r.client.disconnect()}catch{}
    if(r.sessionFingerprint)await releaseSessionLease(r.sessionFingerprint,id).catch(()=>{});
    await releaseRuntimeLease(id).catch(()=>{});
  }
  runtimes.clear();
}