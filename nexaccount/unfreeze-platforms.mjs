// Owner/admin appeal guidance. Official channels require the platform's own
// review/identity check; NexAI does NOT impersonate platform moderation APIs.
export const UNFREEZE_TYPES=Object.freeze({
  tg_account:{
    label:'Compte Telegram',
    portal:'https://telegram.org/faq',
    steps:'Ouvre le compte gelé dans Telegram et utilise le recours affiché dans l’application. Vérifie aussi @SpamBot (https://t.me/SpamBot).',
    identity:'titulaire du compte',
    mode:'in_app'
  },
  tg_channel:{
    label:'Canal Telegram',
    portal:'https://telegram.org/faq',
    steps:'L’administrateur doit expliquer la restriction à abuse@telegram.org, avec le lien du canal et les éléments justificatifs.',
    identity:'propriétaire ou administrateur autorisé du canal',
    mode:'email_manual'
  },
  tg_group:{
    label:'Groupe Telegram',
    portal:'https://telegram.org/support',
    steps:'L’administrateur prépare le lien du groupe, les dates et les détails de la restriction, puis contacte l’assistance Telegram. Le parcours dépend du motif.',
    identity:'propriétaire ou administrateur autorisé du groupe',
    mode:'support'
  },
  wa_account:{
    label:'Compte WhatsApp',
    portal:'https://faq.whatsapp.com/465883178708358/?locale=fr_FR',
    steps:'Dans WhatsApp, ouvre l’écran de bannissement et appuie sur « Demander un examen » si cette option est proposée. Le statut du recours se consulte dans WhatsApp.',
    identity:'titulaire du numéro',
    mode:'in_app'
  },
  wa_group:{
    label:'Groupe WhatsApp',
    portal:'https://faq.whatsapp.com/679236580386110?locale=fr_FR',
    steps:'Seul un administrateur du groupe suspendu peut demander un examen via les options de WhatsApp prévues à cet effet.',
    identity:'administrateur autorisé du groupe',
    mode:'admin_in_app'
  },
  wa_channel:{
    label:'Chaîne WhatsApp',
    portal:'https://faq.whatsapp.com/3440358352849077/',
    steps:'Depuis les notifications et outils de gestion de la chaîne fermée, l’administrateur peut demander le réexamen de la décision, si cette option est disponible.',
    identity:'administrateur autorisé de la chaîne',
    mode:'admin_in_app'
  },
  tiktok_account:{
    label:'Compte TikTok',
    portal:'https://support.tiktok.com/en/safety-hc/account-and-user-safety/content-violations-and-bans',
    steps:'Connecte-toi au compte concerné, ouvre la notification de bannissement puis sélectionne « Contester / Appeal » et suis les instructions.',
    identity:'titulaire du compte',
    mode:'in_app'
  },
  facebook_account:{
    label:'Compte Facebook',
    portal:'https://www.facebook.com/help/103873106370583',
    steps:'Connecte-toi au compte suspendu, suis la notification de suspension et utilise l’option de contestation si elle est encore proposée. Respecte le délai affiché.',
    identity:'titulaire du compte',
    mode:'in_app'
  }
});
export const UNFREEZE_TYPES_LIST=Object.freeze(Object.keys(UNFREEZE_TYPES));
export function unfreezeUsage(){
  return [
    'RECOURS NEXAI · 8 catégories',
    'Créer : /unfreeze <type> <identifiant> <faits>',
    'Types : '+UNFREEZE_TYPES_LIST.join(', '),
    'Exemple : /unfreeze tg_channel @MonCanal Canal suspendu par erreur le 10 octobre.',
    'Voir : /unfreeze_status <type> <identifiant>',
    'Lister : /unfreeze_list',
    'Confirmer un recours réellement déposé : /unfreeze_sent <type> <identifiant>',
    'Résultat réellement reçu : /unfreeze_result <type> <identifiant> approved|rejected',
    'Clôturer : /unfreeze_close <type> <identifiant>',
    'Aucun recours n’est envoyé automatiquement aux plateformes.'
  ].join('\n');
}
export function parseUnfreezeCaseArgs(raw=''){
  const parts=String(raw||'').trim().split(/\s+/).filter(Boolean);
  const type=String(parts[0]||'').toLowerCase();
  const identifier=String(parts[1]||'').trim();
  const detail=parts.slice(2).join(' ').trim().slice(0,1700);
  if(!UNFREEZE_TYPES[type])return {ok:false,error:'Type inconnu.\n'+unfreezeUsage()};
  if(identifier.length<3||identifier.length>220||/[\x00-\x1f<>]/.test(identifier)){
    return {ok:false,error:'Identifiant invalide. Fournis un @username, un numéro ou un lien sans espaces.'};
  }
  return {ok:true,type,identifier,detail};
}
export function appealDraft({type,identifier,detail=''}){
  const p=UNFREEZE_TYPES[type];
  if(!p)throw Error('unfreeze_unknown_type');
  const facts=String(detail||'').trim();
  return [
    'Objet : Demande de réexamen – '+p.label+' – '+identifier,
    '',
    'Bonjour,',
    'Je sollicite le réexamen de la restriction concernant '+identifier+'.',
    'Je peux fournir les éléments établissant que je suis le/la '+p.identity+'.',
    facts?'Faits que je souhaite soumettre : '+facts:'[Décrire les faits précis, le message de suspension et la date.]',
    'Je demande une vérification de cette décision et reste disponible pour toute vérification requise.',
    'Merci pour votre examen.',
  ].join('\n');
}
