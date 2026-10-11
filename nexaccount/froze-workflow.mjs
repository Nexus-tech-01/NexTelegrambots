// Official-report submission + transport-level tracking for compromised accounts.
// One owner's declaration per target. No MTProto mass reports, no target DMs,
// no repeated abuse emails, and no attempt to infer Telegram moderation outcomes.
import { db } from './store.mjs';
import { isFrozeCommand, normalizeFrozeUsername, frozeReason } from './froze-commands.mjs';

const COLLECTION='nexaccount_froze_cases';
const EMAIL_ENDPOINT='https://api.resend.com/emails';
const REPORT_DESTINATION='abuse@telegram.org';
const CHECK_MIN_AGE_MS=30*60*1000;
const MAX_DETAILS_LENGTH=1500;
const MAX_CASES_PER_TICK=3;
const MAX_CHECKS_PER_TICK=6;

export function frozeMailConfig(env=process.env){
  const key=String(env.NEXAI_REPORT_RESEND_API_KEY||'').trim();
  const from=String(env.NEXAI_REPORT_FROM||'').trim();
  const replyTo=String(env.NEXAI_REPORT_REPLY_TO||'').trim();
  const validFrom=/^(?:[^<>]+ <)?[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}>?$/i.test(from);
  const validReply=!replyTo||/^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i.test(replyTo);
  return {
    configured:Boolean(key&&validFrom&&validReply),
    key,from,replyTo,
    // This always targets the published Telegram abuse inbox.
    to:REPORT_DESTINATION
  };
}

export function composeFrozeEmail(record){
  const username=normalizeFrozeUsername(record?.username);
  if(!username)throw new Error('Invalid Telegram username in dossier');
  const reasons=[...new Set(record?.reasons||[])].filter(isFrozeCommand);
  const categories=reasons.map(name=>frozeReason(name)?.label).filter(Boolean);
  const notes=(record?.notes||[]).filter(v=>typeof v==='string'&&v.trim()).map(v=>v.slice(0,MAX_DETAILS_LENGTH));
  const body=[
    'Bonjour,',
    '',
    'Je demande un examen du compte Telegram '+username+' (https://t.me/'+username.slice(1)+').',
    'Je déclare qu’il s’agit d’un ancien compte personnel dont j’ai perdu le contrôle et qui serait maintenant utilisé par une autre personne.',
    '',
    'Motifs que je souhaite signaler : '+(categories.join(', ')||'compromission présumée')+'.',
    'Ces informations sont déclarées par le titulaire présumé et doivent être vérifiées par les modérateurs Telegram.',
    ...(notes.length?['','Observations complémentaires communiquées par le demandeur :',...notes.map(v=>'- '+v)]:[]),
    '',
    'Certains contenus ont, d’après mes observations, été supprimés rapidement ; je ne dispose pas nécessairement de liens de messages encore accessibles.',
    'Je sollicite une vérification, des mesures de sécurisation et, si nécessaire, une suspension selon vos règles.',
    '',
    'Ce message a été établi à ma demande avec NexAI, sans solliciter d’autres comptes pour des signalements coordonnés.',
    'Cordialement.'
  ].join('\n');
  return {
    to:REPORT_DESTINATION,
    subject:'Demande de vérification de compte Telegram compromis : '+username,
    text:body
  };
}

function ownerAndTarget(ownerId,raw){
  const owner=String(ownerId||'').trim();
  const username=normalizeFrozeUsername(raw);
  if(!owner||!username)return null;
  return {owner,username,id:owner+':'+username.toLowerCase()};
}
async function cases(){
  const d=await db();
  const c=d.collection(COLLECTION);
  await c.createIndex({owner:1,updatedAt:-1});
  return c;
}
export function publicFrozeStatus(record,configured=frozeMailConfig().configured){
  if(!record)return 'Aucun dossier trouvé pour ce compte.';
  const state={
    queued:configured?'en attente d’envoi unique':'en attente de configuration de l’envoi e-mail',
    sending:'envoi en cours / statut à confirmer',
    submitted:'accepté par le prestataire e-mail (pas une confirmation de modération Telegram)',
    delivery_failed:'échec de l’envoi ; aucune relance automatique',
    delivery_uncertain:'livraison incertaine ; aucune relance automatique pour éviter les doublons',
    closed:'dossier clôturé manuellement'
  }[record.status]||'état inconnu';
  return [
    'DOSSIER · '+record.username,
    'État : '+state,
    'Motifs : '+(record.reasons||[]).map(x=>frozeReason(x)?.label).filter(Boolean).join(', '),
    record.submittedAt?'Transmission acceptée le : '+new Date(record.submittedAt).toISOString():'',
    record.providerEvent?'Dernier événement e-mail : '+String(record.providerEvent).slice(0,80):'',
    record.lastDeliveryCheckAt?'Dernier contrôle de livraison : '+new Date(record.lastDeliveryCheckAt).toISOString():'',
    record.lastError?'Détail technique : '+String(record.lastError).slice(0,180):'',
    'Gel du compte par Telegram : non vérifié (aucun accès à une décision de modération).',
    'Aucun envoi répété depuis les sessions Telegram.'
  ].filter(Boolean).join('\n');
}
export async function recordFrozeRequest({ownerId,command,args=[]}){
  if(!isFrozeCommand(command))return 'Commande inconnue.';
  const keys=ownerAndTarget(ownerId,args[0]);
  if(!keys)return 'Usage : /'+command+' @username [faits observés]\nAucun dossier transmis.';
  const extra=String(args.slice(1).join(' ')||'').trim().slice(0,MAX_DETAILS_LENGTH);
  const c=await cases();
  const now=new Date();
  const update={
    $setOnInsert:{_id:keys.id,owner:keys.owner,username:keys.username,createdAt:now,status:'queued'},
    $set:{updatedAt:now},
    $addToSet:{reasons:command}
  };
  if(extra)update.$addToSet.notes=extra;
  await c.updateOne({_id:keys.id},update,{upsert:true});
  // Only the first queued submission may send. Later commands consolidate the
  // dossier locally but never submit a second e-mail to Telegram.
  await trySubmitCase(keys.id,{collection:c});
  const record=await c.findOne({_id:keys.id});
  return publicFrozeStatus(record);
}

export async function trySubmitCase(id,{collection=null,fetchImpl=fetch,env=process.env}={}){
  const conf=frozeMailConfig(env);
  if(!conf.configured)return {status:'configuration_required'};
  const c=collection||await cases();
  // Atomic claim prevents duplicate sends from concurrent NexAI workers.
  const claimed=await c.findOneAndUpdate(
    {_id:id,status:'queued'},
    {$set:{status:'sending',lastAttemptAt:new Date()},$inc:{attemptCount:1}},
    {returnDocument:'after'}
  );
  if(!claimed)return {status:'already_claimed_or_finished'};
  const mail=composeFrozeEmail(claimed);
  const idempotencyKey='nexai-froze-'+String(claimed._id).replace(/[^A-Za-z0-9:_-]/g,'').slice(0,150);
  let result={status:'delivery_uncertain',lastError:'Résultat du transport non confirmé'};
  try{
    const payload={from:conf.from,to:[mail.to],subject:mail.subject,text:mail.text};
    if(conf.replyTo)payload.reply_to=conf.replyTo;
    const response=await fetchImpl(EMAIL_ENDPOINT,{
      method:'POST',
      headers:{
        Authorization:'Bearer '+conf.key,
        'Content-Type':'application/json',
        'Idempotency-Key':idempotencyKey
      },
      body:JSON.stringify(payload),
      signal:AbortSignal.timeout(20_000)
    });
    if(response.ok){
      const json=await response.json();
      if(!json?.id)throw new Error('provider_response_without_email_id');
      result={status:'submitted',providerId:String(json.id),submittedAt:new Date(),lastError:null};
    }else{
      // HTTP responses are known refusals, not a reason to retry automatically.
      result={status:'delivery_failed',lastError:'Prestataire e-mail : HTTP '+response.status};
    }
  }catch(error){
    result={status:'delivery_uncertain',lastError:String(error?.message||error).slice(0,180)};
  }
  await c.updateOne({_id:id,status:'sending'},{$set:{...result,updatedAt:new Date()}});
  return result;
}

export async function showFrozeCase(ownerId,raw,{refresh=true}={}){
  const keys=ownerAndTarget(ownerId,raw);
  if(!keys)return 'Usage : /froze_status @username';
  const c=await cases();
  if(refresh)await checkFrozeDelivery(keys.id,{collection:c});
  return publicFrozeStatus(await c.findOne({_id:keys.id}));
}

export async function listFrozeCases(ownerId){
  const c=await cases();
  const rows=await c.find({owner:String(ownerId)}).sort({updatedAt:-1}).limit(20).toArray();
  return rows.length
    ? 'DOSSIERS NEXAI · '+rows.length+'\n'+rows.map(x=>x.username+' · '+x.status).join('\n')+'\n\n/froze_status @username pour les détails.'
    : 'Aucun dossier enregistré. Utilise /froze @username.';
}

export async function closeFrozeCase(ownerId,raw){
  const keys=ownerAndTarget(ownerId,raw);
  if(!keys)return 'Usage : /froze_close @username';
  const c=await cases();
  const outcome=await c.updateOne({_id:keys.id,owner:keys.owner,status:{$nin:['sending']}},{$set:{status:'closed',updatedAt:new Date()}});
  return outcome.modifiedCount?'Dossier clôturé sur demande, sans attester d’un gel Telegram.':'Aucun dossier modifiable trouvé.';
}

export async function checkFrozeDelivery(id,{collection=null,fetchImpl=fetch,env=process.env}={}){
  const conf=frozeMailConfig(env);
  if(!conf.configured)return false;
  const c=collection||await cases();
  const row=await c.findOne({_id:id,status:'submitted',providerId:{$exists:true}});
  if(!row)return false;
  if(row.lastDeliveryCheckAt&&Date.now()-new Date(row.lastDeliveryCheckAt).getTime()<CHECK_MIN_AGE_MS)return false;
  const date=new Date();
  try{
    const response=await fetchImpl(EMAIL_ENDPOINT+'/'+encodeURIComponent(row.providerId),{
      headers:{Authorization:'Bearer '+conf.key},
      signal:AbortSignal.timeout(15_000)
    });
    const body=response.ok?await response.json():null;
    const providerEvent=body?.last_event||body?.status||'accepté, livraison non précisée';
    await c.updateOne({_id:id,status:'submitted'},{$set:{
      lastDeliveryCheckAt:date,
      providerEvent:response.ok?String(providerEvent).slice(0,80):'HTTP '+response.status,
      updatedAt:date
    }});
    return response.ok;
  }catch{
    // Never equate a polling error with a failed Telegram moderation decision.
    await c.updateOne({_id:id,status:'submitted'},{$set:{lastDeliveryCheckAt:date,updatedAt:date}});
    return false;
  }
}

// Called periodically by the sole NexAI Bot API poller. It sends each new case
// once, and only queries the mail provider thereafter. No periodic re-reporting.
export async function reconcileFrozeCases({fetchImpl=fetch,env=process.env}={}){
  if(!frozeMailConfig(env).configured)return {configured:false,submitted:0,checked:0};
  const c=await cases();
  const pending=await c.find({status:'queued'}).sort({createdAt:1}).limit(MAX_CASES_PER_TICK).toArray();
  let submitted=0,checked=0;
  for(const row of pending){
    const result=await trySubmitCase(row._id,{collection:c,fetchImpl,env});
    if(result.status==='submitted')submitted++;
  }
  const readyBefore=new Date(Date.now()-CHECK_MIN_AGE_MS);
  const toCheck=await c.find({status:'submitted',$or:[
    {lastDeliveryCheckAt:{$exists:false}},
    {lastDeliveryCheckAt:{$lt:readyBefore}}
  ]}).sort({lastDeliveryCheckAt:1}).limit(MAX_CHECKS_PER_TICK).toArray();
  for(const row of toCheck){
    if(await checkFrozeDelivery(row._id,{collection:c,fetchImpl,env}))checked++;
  }
  return {configured:true,submitted,checked};
}
