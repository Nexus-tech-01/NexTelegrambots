import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.dirname(HERE);
const store=fs.readFileSync(path.join(ROOT,'store.mjs'),'utf8');
const runtime=fs.readFileSync(path.join(ROOT,'runtime.mjs'),'utf8');
const anime=fs.readFileSync(path.join(ROOT,'anime-ingest.mjs'),'utf8');
const relayPath=path.resolve(ROOT,'..','nexcanal','liteapks-relay.mjs');
const relay=fs.existsSync(relayPath)?fs.readFileSync(relayPath,'utf8'):'';
const standaloneRelayPath=path.resolve(ROOT,'..','watchers','liteapks-relay.mjs');
const standaloneRelay=fs.existsSync(standaloneRelayPath)?fs.readFileSync(standaloneRelayPath,'utf8'):'';

assert.match(store,/sessionRepairRequired:\s*false/);
assert.match(store,/markSessionRepairRequired/);
assert.match(store,/sessionRepairRequired:\{\$ne:true\}/);
assert.doesNotMatch(store,/reservedWatcherId/);
assert.match(runtime,/markSessionRepairRequired\(id,'AUTH_KEY_DUPLICATED'\)/);
assert.match(runtime,/markSessionRepairRequired\(id,'SESSION_UNAUTHORIZED'\)/);
assert.match(store,/never steal a lease from another live/);
assert.match(store,/looksLikeNexAccount/);
assert.doesNotMatch(store,/if\(cfg\.workerCount===1\)\{\s*const updated=await leases\.updateOne\(\{_id:id\},set\)/s);
assert.match(runtime,/if\(r\.sessionFingerprint\)await releaseSessionLease\(r\.sessionFingerprint,id\)/);
assert.match(anime,/REQUIRED_LISTENERS=\['tresor20001','tresor20009','tresor20000'\]/);
assert.match(anime,/const PUBLISH_MS=30_000;/);
assert.match(anime,/const INTER_SERIES_MS=15\*60_000;/);
if(relay){
  assert.match(relay,/NEXCANAL_SOCIAL_FEED_ENABLED\|\|'false'/);
  assert.match(relay,/legacy social feed disabled/);
  assert.match(relay,/function floodWaitDelayMs\(error\)/);
  assert.match(relay,/embedded scanner paused for Telegram FloodWait/);
  assert.match(relay,/await waitWithSignal\(waitMs,signal\)/);
  assert.match(relay,/sourceResolveRetryMs/);
  assert.match(relay,/source unavailable at startup; isolated retry enabled/);
  assert.match(relay,/source still unavailable; other APK sources continue/);
  assert.doesNotMatch(relay,/required source unavailable:/);
}
if(standaloneRelay){
  assert.match(standaloneRelay,/sourceResolveRetryMs/);
  assert.match(standaloneRelay,/source unavailable at startup; isolated retry enabled/);
  assert.match(standaloneRelay,/source still unavailable; other APK sources continue/);
  assert.doesNotMatch(standaloneRelay,/required source unavailable:/);
}
console.log(JSON.stringify({ok:true,sessionRepair:true,independentWatcherSession:true,animeCadence:true,legacyDarkFeedDisabled:true}));
