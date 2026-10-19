/**
 * Transform Telegram Otaku Nexus captions into WhatsApp editorial posts while
 * preserving all original text, source links and publication facts. No AI
 * hallucination: embellishment is structural, not factual.
 */
const clean=value=>String(value??'').trim();
export const OTAKU_RELAY_SOURCE='theotaku_nexus';

export function classifyOtakuPost(text,{hasMedia=false}={}){
  const v=clean(text).toLowerCase();
  if(/(?:pack de stickers|sticker pack|wastickers|débloqu|debloc)/.test(v))return 'stickers';
  if(/(?:sondage|votez|vote |qui gagne|versus| vs |duel)/.test(v))return 'poll';
  if(/(?:quiz|devinette|personnage mystère|enigme|énigme)/.test(v))return 'quiz';
  if(/(?:chapitre|chapter|episode|épisode|nouvelle saison|saison \d|date de sortie|sortira|sortie officielle|annonce|annoncé|trailer|bande-annonce)/.test(v))return 'news';
  if(/(?:webtoon|manhwa|manga)/.test(v)&&/(?:recomm|conseil|découvr|lecture|pépite|pepites)/.test(v))return 'manga';
  if(/(?:anime|animé)/.test(v)&&/(?:recomm|conseil|découvr|à voir|pépite)/.test(v))return 'anime';
  if(/(?:classement|top \d|tendance|trending|popularit)/.test(v))return 'trending';
  if(/(?:theorie|théorie|spoiler|secret|le savais-tu|anecdote)/.test(v))return 'facts';
  if(/(?:wallpaper|fond d'écran|wallpapers)/.test(v))return 'wallpaper';
  if(/(?:edit|amv|ost|edit audio)/.test(v)&&hasMedia)return 'amv';
  return hasMedia?'media':'general';
}

export function formatOtakuTelegramRelay(original,{media=[],source='theotaku_nexus'}={}){
  if(clean(source).replace(/^@/,'').toLowerCase()!==OTAKU_RELAY_SOURCE)return clean(original);
  const content=clean(original);
  if(!content)return content;
  if(/#OtakuNexus\b/i.test(content)&&/━━━━━━━━|╭────|╰────/.test(content))return content;
  const category=classifyOtakuPost(content,{hasMedia:Array.isArray(media)&&media.length>0});
  const headers={
    stickers:'🍜🎁 OTAKU NEXUS — PACK DE STICKERS ! 🎌',
    poll:'⚔️🔥 LE DÉBAT OTAKU EST OUVERT ! 👀',
    quiz:'🧠💥 DÉFI OTAKU — SAURAS-TU RÉPONDRE ? 🎌',
    news:'🚨🔥 OTAKU NEXUS — DERNIÈRES NOUVELLES ! 🎬',
    manga:'📚👑 UNE LECTURE À DÉCOUVRIR ! ✨',
    anime:'🌸🎬 TON PROCHAIN ANIME ? 🍿',
    trending:'📈🔥 LES TENDANCES OTAKU ! 👑',
    facts:'🧩😱 LE COIN DES SECRETS OTAKU ! 🔎',
    wallpaper:'🖼️🌙 WALLPAPER DROP ! ✨',
    amv:'🎥⚡ AMV / EDIT OTAKU ! 🎶',
    media:'🎌🔥 OTAKU NEXUS — À DÉCOUVRIR !',
    general:'🎌✨ L’UNIVERS OTAKU NEXUS !'
  };
  const title=headers[category];
  // Keep the content verbatim. In particular, don't accidentally restate an
  // old article as new, add an unverified date, or strip source attribution.
  const suffix=/#OtakuNexus\b/i.test(content)?'':'\n\n#OtakuNexus 🎌';
  return title+'\n\n'+content+suffix;
}
