import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const PINNED_ANIME_SHA256='2dd7ff58991788191a1ecd0682ffcecedd5ce02d405bd806c4da492501373c93';

const CONTRACT={
  'anime-ingest.mjs':[
    'const PUBLISH_MS=30_000;',
    'const INTER_SERIES_MS=15*60_000;',
    'async function preflightSeriesBeforeSynopsis',
    "blockedSeriesReason:'source_unavailable_after_retries'",
    'function scheduleDiscoveryRetry',
    'export async function startAnimeIngest',
    'export async function stopAnimeIngest',
    'export async function animeSystemStatus',
    'enabled:a.enabled===true,listener:a.listener===true,publisher:a.publisher===true'
  ],
  'runtime.mjs':[
    'startAnimeIngest',
    'stopAnimeIngest',
    'handleAnimeIngestEvent',
    'ANIME_PRIMARY_PUBLISHER_USERNAME',
    'await startAnimeIngest(runtime)'
  ],
  'daemon.mjs':[
    'animeSystemStatus',
    "'/anime/status'",
    "'/anime/publish-now'"
  ],
  'store.mjs':[
    'export async function acquireServiceLease',
    'export async function renewServiceLease',
    'export async function releaseServiceLease'
  ]
};

export async function assertAnimeRuntimeContract(root=here){
  const failures=[];
  for(const [relative,markers] of Object.entries(CONTRACT)){
    const file=path.join(root,relative);
    let source='';
    try{source=await fs.readFile(file,'utf8')}
    catch(error){
      failures.push(relative+': unreadable ('+String(error?.code||error?.message||error)+')');
      continue;
    }
    for(const marker of markers){
      if(!source.includes(marker))failures.push(relative+': missing '+JSON.stringify(marker));
    }
    if(relative==='anime-ingest.mjs'){
      const actual=crypto.createHash('sha256').update(source,'utf8').digest('hex');
      if(actual!==PINNED_ANIME_SHA256){
        failures.push(relative+': protected SHA-256 changed ('+actual+' != '+PINNED_ANIME_SHA256+')');
      }
    }
  }
  if(failures.length){
    const error=new Error('NEXANIME_PROTECTION_GATE_FAILED\n'+failures.join('\n'));
    error.code='NEXANIME_PROTECTION_GATE_FAILED';
    error.failures=failures;
    throw error;
  }
  return {ok:true,version:2,files:Object.keys(CONTRACT),protectedAnimeSha256:PINNED_ANIME_SHA256};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assertAnimeRuntimeContract().then(result=>{
    process.stdout.write(JSON.stringify(result)+'\n');
  }).catch(error=>{
    console.error(String(error?.message||error));
    process.exitCode=1;
  });
}
