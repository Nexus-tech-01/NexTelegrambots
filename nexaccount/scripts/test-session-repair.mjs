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

assert.match(store,/sessionRepairRequired:\s*false/);
assert.match(store,/markSessionRepairRequired/);
assert.match(store,/sessionRepairRequired:\{\$ne:true\}/);
assert.doesNotMatch(store,/reservedWatcherId/);
assert.match(runtime,/markSessionRepairRequired\(id,'AUTH_KEY_DUPLICATED'\)/);
assert.match(runtime,/markSessionRepairRequired\(id,'SESSION_UNAUTHORIZED'\)/);
assert.match(anime,/REQUIRED_LISTENERS=\['tresor20001','tresor20009','tresor20000'\]/);
assert.match(anime,/const PUBLISH_MS=30_000;/);
assert.match(anime,/const INTER_SERIES_MS=15\*60_000;/);
if(relay){
  assert.match(relay,/NEXCANAL_SOCIAL_FEED_ENABLED\|\|'false'/);
  assert.match(relay,/legacy social feed disabled/);
}
console.log(JSON.stringify({ok:true,sessionRepair:true,independentWatcherSession:true,animeCadence:true,legacyDarkFeedDisabled:true}));
