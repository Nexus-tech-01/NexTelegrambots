export const RUNTIME_TIMER_KEYS=[
  'autoJoinTimer',
  'presenceTimer',
  'updateSyncTimer',
  'commandPollTimer',
  'leaseTimer',
  'emojiLibraryTimer',
  'premiumPowersTimer'
];

export function createRuntimeContext({client,account,animePublisher=false}){
  return {
    client,
    account,
    animePublisher,
    startedAt:new Date(),
    lastUpdateAt:null,
    lastCatchUpAt:null,
    updateCount:0,
    catchUpFailures:0,
    syncing:false,
    commandPollStartedAt:Date.now(),
    lastCommandPollAt:null,
    commandPollFailures:0,
    pollingCommands:false,
    autoJoinTimer:null,
    presenceTimer:null,
    updateSyncTimer:null,
    commandPollTimer:null,
    leaseTimer:null,
    emojiLibraryTimer:null,
    premiumPowersTimer:null
  };
}

export function clearRuntimeTimers(runtime){
  if(!runtime)return;
  for(const key of RUNTIME_TIMER_KEYS){
    if(runtime[key]){
      clearInterval(runtime[key]);
      runtime[key]=null;
    }
  }
}
