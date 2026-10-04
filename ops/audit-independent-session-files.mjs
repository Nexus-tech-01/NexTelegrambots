import fs from 'node:fs';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';

const live=fs.realpathSync('/opt/nex/apps/public/nexai/current');
for(const raw of fs.readFileSync('/etc/nex/secrets/legacy-root.env','utf8').split(/\r?\n/)){
  let line=raw.trim();
  if(!line||line.startsWith('#'))continue;
  if(line.startsWith('export '))line=line.slice(7).trim();
  const i=line.indexOf('=');
  if(i<1)continue;
  let value=line.slice(i+1).trim();
  if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
  if(process.env[line.slice(0,i).trim()]===undefined)process.env[line.slice(0,i).trim()]=value;
}
process.env.NEXACCOUNT_TELEGRAM_API_ID ||= process.env.NEXGROUP__TELEGRAM_API_ID||process.env.TELEGRAM_API_ID||'';
process.env.NEXACCOUNT_TELEGRAM_API_HASH ||= process.env.NEXGROUP__TELEGRAM_API_HASH||process.env.TELEGRAM_API_HASH||'';

const store=await import(pathToFileURL(live+'/store.mjs').href);
const rows=await store.listAccounts();
const files=[
  '/var/lib/nex/sessions/system/nexcanal-reader-session.txt',
  '/var/lib/nex/sessions/internal/nexcanal-publisher-session.txt'
];
const authKeyFingerprint=value=>{
  const session=String(value||'').trim();
  if(session.length<10)return '';
  try{
    const body=session.slice(1).replace(/-/g,'+').replace(/_/g,'/');
    const decoded=Buffer.from(body,'base64');
    if(decoded.length<256)return '';
    return crypto.createHash('sha256').update(decoded.subarray(decoded.length-256)).digest('hex');
  }catch{return ''}
};
const accounts=[];
for(const row of rows){
  const full=await store.accountWithSession(String(row.telegramUserId));
  accounts.push({
    telegramUserId:String(row.telegramUserId),
    username:String(row.username||''),
    fingerprint:authKeyFingerprint(full?.session||'')
  });
}
const out=files.map(file=>{
  let value='';try{value=fs.readFileSync(file,'utf8').trim()}catch{}
  const fingerprint=authKeyFingerprint(value);
  return {
    file,
    size:value.length,
    readable:Boolean(fingerprint),
    matchesCore:accounts
      .filter(a=>a.fingerprint&&a.fingerprint===fingerprint)
      .map(a=>({telegramUserId:a.telegramUserId,username:a.username})),
    fingerprint
  };
});
console.log(JSON.stringify({
  accounts:accounts.map(a=>({telegramUserId:a.telegramUserId,username:a.username})),
  sessions:out.map(x=>({
    file:x.file,size:x.size,readable:x.readable,matchesCore:x.matchesCore,
    keyTag:x.fingerprint?x.fingerprint.slice(0,12):''
  })),
  distinctIndependentKeys:Boolean(out[0]?.fingerprint&&out[1]?.fingerprint&&out[0].fingerprint!==out[1].fingerprint)
}));
process.exit(0);
