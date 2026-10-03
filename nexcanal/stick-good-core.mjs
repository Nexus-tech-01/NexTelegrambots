const clean=v=>String(v??'').trim();

export const STICK_GOOD_PREFIX='ঔৣ𝐒𝐓𝐈𝐂𝐊 𝐆𝐎𝐎𝐃ঔৣ♫  ݁  ݂';

export function normalizeKey(value){
  return clean(value).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9\u0400-\u04ff]+/g,' ')
    .trim();
}

export function unicodeBold(value){
  return Array.from(String(value??'').normalize('NFD')).map(ch=>{
    const c=ch.codePointAt(0);
    if(c>=65&&c<=90)return String.fromCodePoint(0x1D400+(c-65));
    if(c>=97&&c<=122)return String.fromCodePoint(0x1D41A+(c-97));
    if(c>=48&&c<=57)return String.fromCodePoint(0x1D7CE+(c-48));
    return ch;
  }).join('');
}

export function canonicalDisplayName(value){
  return clean(value).replace(/\s+/g,' ').replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g,'');
}

export function stickGoodPackName(character){
  const c=canonicalDisplayName(character);
  return STICK_GOOD_PREFIX+' '+unicodeBold(c.toUpperCase());
}

export function stickGoodPresentation(character){
  const c=canonicalDisplayName(character).toUpperCase();
  return [
    'ঔৣ𝐒𝐓𝐈𝐂𝐊 𝐆𝐎𝐎𝐃ঔৣ. \` ⚖️⚖️  𓏴𓏴',
    '          ֶ ☽    *pack* \`!!\` ⊹ . ??',
    '\`'+c+'\`',
    '      ︶︶֪︶ ୨ৎ︶֪︶︶ .🌹',
    '–  📸⃞         ঔৣ𝐒𝐓𝐈𝐂𝐊 𝐆𝐎𝐎𝐃ঔৣ♫  ݁  ݂',
    '> ۫   .  ֺ   𝐁𝐘 𑂯 ₊‧ ⚖️𝒯𝓇𝑒́𝓈𝑜𝓇𝄞⃟!  𝄒𝄒     Ი𐑼',
    '́               ꒰͡    ׅ  ❄️꒱',
    '',
    '⎯    ㅤ۪  ⬭ \`ׅs𝘁і𝗰ks ᥎ᥱ𝗿s𝗲\` ㅤ۪  𓄳  ׁ',
    ' 🪄🪄',
    '',
    '        𓂃  \`'+c+'\`'
  ].join('\n');
}

export function wishlistText(){
  return [
    'ㅤ୨୧ ˚₊‧ 𝐒𝐓𝐈𝐂𝐊 𝐆𝐎𝐎𝐃 — 𝐖𝐈𝐒𝐇 𝐋𝐈𝐒𝐓 🎀',
    '',
    'Quel personnage veux-tu voir dans le prochain pack ? ✨',
    'Réponds directement à cette question avec le nom du personnage ♡',
    '',
    'Anime • Films • Séries 🌸',
    'Une vraie demande = un personnage précis pour un pack de stickers.'
  ].join('\n');
}

export function isMixedPackMeta(value){
  const raw=clean(value).toLowerCase();
  const norm=normalizeKey(raw);
  return /(?:смешан|микс|разн)/i.test(raw)||
    /\b(?:mixed|mix pack|anime mix|random|assorted|various|multi character|multicharacter|crossover|all anime|multi fandom|multifandom)\b/i.test(norm);
}

export function characterTokens(character){
  const norm=normalizeKey(character);
  const stop=new Set(['anime','the','and','from','chan','kun','san','mr','mrs']);
  const words=norm.split(/\s+/).filter(x=>x.length>=3&&!stop.has(x));
  const compact=norm.replace(/\s+/g,'');
  return [...new Set([compact,...words].filter(x=>x.length>=3))];
}

export function packLooksCharacterSpecific(character,{title='',setName='',sourceText=''}={}){
  const raw=[title,setName,sourceText].filter(Boolean).join(' ');
  if(!raw||isMixedPackMeta(raw))return false;
  const norm=normalizeKey(raw),compact=norm.replace(/\s+/g,'');
  const tokens=characterTokens(character);
  if(!tokens.length)return false;
  const hits=tokens.filter(t=>compact.includes(t.replace(/\s+/g,''))||norm.split(/\s+/).includes(t));
  return hits.length>=Math.min(2,tokens.length)||hits.some(x=>x.length>=5);
}

export function fallbackWishlistCandidate(text){
  const raw=clean(text).replace(/\s+/g,' ');
  if(!raw||raw.length>100||/https?:\/\//i.test(raw))return {valid:false};
  const norm=normalizeKey(raw);
  if(/^(?:salut|bonjour|bonsoir|merci|mdr|lol|ok|oui|non|hey|yo)(?:\s|$)/.test(norm)&&norm.split(/\s+/).length<4)return {valid:false};
  if(/\b(?:qui est|pourquoi|comment|meilleur que|vs|versus|episode|saison|spoiler)\b/.test(norm)&&!/(?:pack|sticker|veux|voudrais|fais|faire)/.test(norm))return {valid:false};
  let candidate=raw
    .replace(/^(?:je\s+)?(?:veux|voudrais|aimerais)\s+(?:un\s+)?(?:pack\s+(?:de\s+)?)?(?:stickers?\s+(?:de\s+)?)?/i,'')
    .replace(/^(?:fais|faites|faire|tu peux faire|peux-tu faire|stp|svp)\s+(?:moi\s+)?(?:un\s+)?(?:pack\s+(?:de\s+)?)?(?:stickers?\s+(?:de\s+)?)?/i,'')
    .replace(/^(?:pack|stickers?)\s+(?:de\s+|pour\s+)?/i,'')
    .replace(/\b(?:stp|svp|please|merci)\b[.!?…]*$/i,'')
    .replace(/[!?.,…]+$/g,'').trim();
  if(candidate.length<2||candidate.length>70)return {valid:false};
  const words=candidate.split(/\s+/);
  if(words.length>8)return {valid:false};
  return {valid:true,character:candidate,confidence:0.45};
}

export const STICK_GOOD_MOODS=['kawaii','calme','joyeux','élégant','dark','romantique','funny','cute','pastel'];
