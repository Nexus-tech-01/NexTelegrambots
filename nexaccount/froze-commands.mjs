// Private, owner-only evidence dossier helper.
// Deliberately never invokes Telegram's report API or opens a chat with the target.
const REASONS=Object.freeze({
  froze:{label:'compromission présumée et abus multiples',details:'Compte déclaré compromis ; demander un examen des publications, des messages et des éventuelles infractions (spam, usurpation, harcèlement, propos haineux et contenus sexuels non sollicités).'},
  froze_spam:{label:'spam',details:'Messages ou publications non sollicités susceptibles de constituer du spam.'},
  froze_hack:{label:'compte compromis',details:'Ancien compte dont le propriétaire déclare avoir perdu le contrôle au profit d’un tiers.'},
  froze_fake:{label:'fausses informations / usurpation',details:'Publications présentées comme trompeuses ou usurpant une identité. Indiquer les affirmations et les éléments vérifiables.'},
  froze_harassment:{label:'harcèlement / insultes',details:'Messages offensants ou non sollicités dirigés vers des utilisateurs.'},
  froze_porn:{label:'contenus sexuels non sollicités',details:'Contenus sexuels explicites envoyés sans consentement ou en violation des règles applicables ; décrire les faits sans joindre de média illégal.'},
  froze_hate:{label:'propos haineux / racistes',details:'Propos discriminatoires ou incitant à la haine ; préciser les expressions et le contexte.'},
  froze_evasion:{label:'contournement de restrictions',details:'Comportement suspect de contournement des limitations de Telegram ; expliquer les indices disponibles.'}
});
export const FROZE_COMMANDS=Object.freeze(Object.keys(REASONS));
export function isFrozeCommand(command){
  return Object.hasOwn(REASONS,String(command||'').toLowerCase());
}
export function normalizeFrozeUsername(raw){
  const value=String(raw||'').trim();
  const match=value.match(/^(?:@|https?:\/\/(?:t\.me|telegram\.me)\/)?([A-Za-z][A-Za-z0-9_]{4,31})\/?$/i);
  return match?'@'+match[1]:null;
}
export function formatFrozeDossier(command,args=[]){
  const name=String(command||'').toLowerCase();
  if(!isFrozeCommand(name))return null;
  const username=normalizeFrozeUsername(args[0]);
  if(!username){
    return 'Usage : /'+name+' @username\n\nVariantes : '+FROZE_COMMANDS.join(', ')+'\n\nCette commande prépare un dossier privé ; elle ne gèle pas le compte et ne lance aucun signalement automatique.';
  }
  const reason=REASONS[name];
  return [
    'DOSSIER DE SIGNALEMENT · '+username,
    'Motif : '+reason.label,
    '',
    'Demande à transmettre aux modérateurs Telegram :',
    'Bonjour, je demande un examen du compte '+username+'.',
    reason.details,
    'Je déclare avoir perdu le contrôle de cet ancien compte. Je demande une vérification, la sécurisation du compte et, si les faits sont confirmés, les mesures appropriées.',
    '',
    'Éléments à joindre si disponibles : dates approximatives, captures d’écran, témoins, liens vers les messages encore accessibles et preuve de propriété du compte.',
    'Même si des messages ont été supprimés, indiquer quand et où les comportements ont été observés.',
    '',
    'Canaux officiels : https://telegram.org/support · abuse@telegram.org',
    '',
    'Statut : brouillon uniquement. Aucune demande envoyée ; aucun compte contacté ou gelé.'
  ].join('\n');
}
