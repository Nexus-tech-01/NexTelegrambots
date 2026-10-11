// Persistent, private, owner-only recovery dossiers.
// NexAI prepares a case, not a platform-side decision or an automatic appeal.
import crypto from 'node:crypto';
import { db } from './store.mjs';
import { UNFREEZE_TYPES, parseUnfreezeCaseArgs, appealDraft, unfreezeUsage } from './unfreeze-platforms.mjs';

const COLLECTION='nexaccount_unfreeze_cases';
const REVIEW_WINDOW_MS=24*60*60*1000;
const STATES=Object.freeze({
  draft:'Brouillon : recours non transmis',
  submitted:'Dépôt déclaré par le propriétaire (non vérifié automatiquement)',
  followup_due:'Vérification manuelle recommandée (aucune nouvelle demande envoyée)',
  approved:'Réactivation confirmée manuellement par le propriétaire',
  rejected:'Refus du recours déclaré par le propriétaire',
  closed:'Dossier clôturé'
});
const VALID_TRANSITIONS=Object.freeze({
  sent:new Set(['draft','followup_due']),
  approved:new Set(['submitted','followup_due']),
  rejected:new Set(['submitted','followup_due']),
  closed:new Set(['draft','submitted','followup_due','rejected','approved'])
});
const asOwner=id=>String(id||'').trim();
const key=(ownerId,type,identifier)=>crypto.createHash('sha256')
  .update(asOwner(ownerId)+'\x00'+type+'\x00'+identifier.toLowerCase()).digest('hex');

async function collection(){
  const c=(await db()).collection(COLLECTION);
  await c.createIndex({ownerId:1,updatedAt:-1});
  await c.createIndex({state:1,reviewDueAt:1});
  return c;
}
export function unfreezeCaseText(row){
  if(!row)return 'Dossier introuvable. Utilise /unfreeze pour en créer un.';
  const p=UNFREEZE_TYPES[row.type];
  return [
    'RECOURS NEXAI · '+p.label,
    'Identifiant : '+row.identifier,
    'État : '+(STATES[row.state]||'inconnu'),
    row.sentAt?'Dépôt déclaré le : '+new Date(row.sentAt).toISOString():'',
    row.reviewDueAt&&row.state==='submitted'?'Prochaine vérification manuelle recommandée : '+new Date(row.reviewDueAt).toISOString():'',
    '',
    'Procédure officielle : '+p.steps,
    'Aide : '+p.portal,
    '',
    'BROUILLON À UTILISER DANS LA PROCÉDURE OFFICIELLE',
    appealDraft(row),
    '',
    'NexAi ne soumet pas ce recours automatiquement et ne peut pas connaître la décision avant ta confirmation.',
    'Après un vrai dépôt : /unfreeze_sent '+row.type+' '+row.identifier,
    'Consulter : /unfreeze_status '+row.type+' '+row.identifier
  ].filter(Boolean).join('\n').slice(0,3900);
}
export async function createUnfreezeCase({ownerId,raw},opts={}){
  const parsed=parseUnfreezeCaseArgs(raw);
  if(!parsed.ok)return parsed.error;
  const owner=asOwner(ownerId);
  if(!owner)throw Error('unfreeze_owner_required');
  const c=opts.collection||await collection();
  const now=new Date();
  const _id=key(owner,parsed.type,parsed.identifier);
  await c.updateOne({_id},{$setOnInsert:{
    _id,ownerId:owner,type:parsed.type,identifier:parsed.identifier,
    detail:parsed.detail,state:'draft',createdAt:now,updatedAt:now
  }},{upsert:true});
  return unfreezeCaseText(await c.findOne({_id,ownerId:owner}));
}
export async function statusUnfreezeCase(ownerId,raw,opts={}){
  const parsed=parseUnfreezeCaseArgs(raw);
  if(!parsed.ok)return 'Usage : /unfreeze_status <type> <identifiant>\n'+unfreezeUsage();
  const owner=asOwner(ownerId);
  const c=opts.collection||await collection();
  return unfreezeCaseText(await c.findOne({_id:key(owner,parsed.type,parsed.identifier),ownerId:owner}));
}
export async function listUnfreezeCases(ownerId,opts={}){
  const c=opts.collection||await collection();
  const rows=await c.find({ownerId:asOwner(ownerId)}).sort({updatedAt:-1}).limit(20).toArray();
  if(!rows.length)return 'Aucun dossier de recours.\n'+unfreezeUsage();
  return 'RECOURS NEXAI · '+rows.length+'\n'+rows.map((x,i)=>(
    (i+1)+'. '+UNFREEZE_TYPES[x.type].label+' '+x.identifier+' — '+(STATES[x.state]||x.state)
  )).join('\n')+'\n\n/unfreeze_status <type> <identifiant> pour ouvrir un dossier.';
}
export async function markUnfreezeCase({ownerId,raw,action},opts={}){
  const parsed=parseUnfreezeCaseArgs(raw);
  if(!parsed.ok)return 'Usage : /unfreeze_'+action+' <type> <identifiant>';
  const owner=asOwner(ownerId);
  const c=opts.collection||await collection();
  const id=key(owner,parsed.type,parsed.identifier);
  const now=new Date();
  const states={
    sent:'submitted',approved:'approved',rejected:'rejected',closed:'closed'
  };
  if(!VALID_TRANSITIONS[action])return 'Action de recours inconnue.';
  const next=states[action];
  const patch={state:next,updatedAt:now};
  if(action==='sent'){
    patch.sentAt=now;
    patch.reviewDueAt=new Date(now.getTime()+REVIEW_WINDOW_MS);
  }
  if(action==='approved'||action==='rejected')patch.decidedAt=now;
  const outcome=await c.updateOne(
    {_id:id,ownerId:owner,state:{$in:[...VALID_TRANSITIONS[action]]}},
    {$set:patch}
  );
  if(!outcome.modifiedCount){
    return 'Aucune transition effectuée. Vérifie le dossier et son état actuel avec /unfreeze_status.';
  }
  return (action==='sent'?'Dépôt enregistré d’après ta confirmation, sans vérification de la plateforme.\n':
    action==='approved'?'Décision favorable enregistrée sur ta déclaration.\n':
    action==='rejected'?'Refus enregistré sur ta déclaration.\n':'Dossier clôturé.\n')+
    unfreezeCaseText(await c.findOne({_id:id,ownerId:owner}));
}
// Called by the singleton NexAI bot every 5 minutes. Only marks previously
// submitted cases as requiring a human status check; NEVER submits an appeal.
export async function reconcileUnfreezeCases(opts={}){
  const c=opts.collection||await collection();
  const now=opts.now||new Date();
  const result=await c.updateMany({
    state:'submitted',reviewDueAt:{$lte:now}
  },{$set:{state:'followup_due',updatedAt:now}});
  return {needsManualReview:result.modifiedCount||0,submittedExternally:0};
}
