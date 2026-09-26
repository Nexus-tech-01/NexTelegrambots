/**
 * Menu Command - THE BIG DIPPER
 * 20 styles + catégories qui changent selon le personnage
 * .style1 → .style20 pour changer
 */

const config       = require('../../config');
const sessionContext = require('../../utils/sessionContext');
const { loadCommands } = require('../../utils/commandLoader');
const prefix = config.prefix || '.';
const styleManager = require('../../utils/styleManager');
const { getCustomMenuConfig } = require('../group_management/custommenu');
const { getConnectedOwnerName } = require('../../utils/ownerIdentity');

// Utilise la configuration officielle (config.supremeOwnerLids), pas une
// liste codée en dur — évite l'incohérence trouvée précédemment (un seul
// des deux LID réels était présent ici).
const SUPREME_JIDS = config.supremeOwnerLids || [];
// styleActif géré par styleManager

function toSmallCaps(text) {
  if (!text) return '';
  const n = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const s = 'ᴀʙᴄᴅᴇғɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ0123456789';
  return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .split('').map(c=>{const i=n.indexOf(c);return i!==-1?s[i]:c;}).join('');
}
function toBSC(text) {
  if (!text) return '';
  const n = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const s = 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ0123456789';
  return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .split('').map(c=>{const i=n.indexOf(c);return i!==-1?s[i]:c;}).join('');
}

// ══════════════════════════════════════════════════════════════
// 🖼️  IMAGES DU MENU — PERSONNALISABLES
// ══════════════════════════════════════════════════════════════
// ➤ Pour chaque style (1 à 10), tu peux mettre jusqu'à 8 URLs
//   d'images. Le bot en choisit une au hasard à chaque .menu
//
// ➤ Comment ajouter tes images :
//   1. Héberge ton image sur : https://imgur.com (Upload → lien direct .jpg/.png)
//                          ou : https://files.catbox.moe
//                          ou : n'importe quel lien direct vers une image
//   2. Colle le lien dans le tableau du style correspondant
//   3. Tu peux mettre entre 1 et 8 liens par style
//
// ➤ Si tu laisses un tableau vide [], le menu s'affiche sans image
// ══════════════════════════════════════════════════════════════
const STYLE_IMAGE_URLS = {

  // ── Style 0 : DIPPER (identité officielle) ─────────────────
  // TODO : Remplacer par l'URL de l'image officielle du Style 0
  0: [
    '',
  ],

  // ── Style 1 : 𝐃𝐈𝐏𝐏𝐄𝐑 ───────────────────────────────────────
  1: [
    // Colle ici jusqu'à 8 liens d'images pour le style Dark
    // Exemple : 'https://i.imgur.com/tonimage.jpg',
    'https://i.imgur.com/6F2V6eD.jpeg',
    'https://i.imgur.com/nX1WVHH.jpeg',
    'https://i.imgur.com/3z2ABPN.jpeg',
    // Slots libres (remplace ou ajoute tes URLs) :
    'https://files.catbox.moe/km94ug.png',
    'https://files.catbox.moe/mffape.png',
    'https://files.catbox.moe/7xbk4p.png',
    '',
    '',
    '',
    '',
    '',
  ],

  // ── Style 2 : Naruto ───────────────────────────────────────
  2: [
    'https://i.imgur.com/UlDSoMy.jpeg',
    'https://i.imgur.com/Q8jbvKo.jpeg',
    'https://i.imgur.com/YK2BKBZ.jpeg',
     'https://files.catbox.moe/muab4m.jpg',
     'https://files.catbox.moe/5b351a.jpg',
     'https://files.catbox.moe/cnglhu.jpg',
     'https://files.catbox.moe/07lfop.jpg',
     'https://files.catbox.moe/211w67.jpg',
     'https://files.catbox.moe/dtj3s9.jpg',
     'https://files.catbox.moe/t4v076.jpg',
     'https://files.catbox.moe/5yjazr.jpg',
  ],

  // ── Style 3 : Cid Kagenou ──────────────────────────────────
  3: [
    'https://i.imgur.com/2v3YMYW.jpeg',
    'https://i.imgur.com/YaFRkON.jpeg',
    'https://i.imgur.com/wMqFGHH.jpeg',
     'https://files.catbox.moe/mwcq4j.jpg',
     'https://files.catbox.moe/3ii420.jpg',
     'https://files.catbox.moe/ak3hnu.jpg',
     'https://files.catbox.moe/vrz54q.jpg',
     'https://files.catbox.moe/87aqe4.jpg',
     'https://files.catbox.moe/h960vp.jpg',
     'https://files.catbox.moe/uaglet.jpg',
     'https://files.catbox.moe/vpfs80.jpg',
     'https://files.catbox.moe/9we55g.jpg',
     'https://files.catbox.moe/s2epgj.jpg',
  ],

  // ── Style 4 : Hacker ───────────────────────────────────────
  4: [
    'https://i.imgur.com/OhY9sTe.jpeg',
    'https://i.imgur.com/dvGCVmo.jpeg',
    'https://i.imgur.com/qS3c5dh.jpeg',
    'https://files.catbox.moe/xfb193.jpg',
    'https://files.catbox.moe/6amjh9.jpg',
    'https://files.catbox.moe/oouy96.jpg',
    'https://files.catbox.moe/vki01s.jpg',
    'https://files.catbox.moe/11t5wk.jpg',
    'https://files.catbox.moe/16vuqn.jpg',
    'https://files.catbox.moe/6p9lbk.jpg',
    'https://files.catbox.moe/ir0g61.jpg',
    'https://files.catbox.moe/lwcmlg.jpg',
    'https://files.catbox.moe/4tytog.jpg',
    'https://files.catbox.moe/s2epgj.jpg',
    
  ],

  // ── Style 5 : Manhwa ───────────────────────────────────────
  5: [
    'https://i.imgur.com/BJHbV2X.jpeg',
    'https://i.imgur.com/YDGmsDN.jpeg',
    'https://i.imgur.com/4jJukHR.jpeg',
    'https://files.catbox.moe/yp09dh.jpg',
    'https://files.catbox.moe/qlv9rl.jpg',
    'https://files.catbox.moe/7ewuua.jpg',
    'https://files.catbox.moe/awrwem.jpg',
    'https://files.catbox.moe/sfvi8b.jpg',
    'https://files.catbox.moe/eony8h.jpg',
    'https://files.catbox.moe/zbvq7j.jpg',
  ],

  // ── Style 6 : Ai Oshino ────────────────────────────────────
  6: [
    'https://i.imgur.com/Rb0ZWOH.jpeg',
    'https://i.imgur.com/7b4iuDP.jpeg',
    'https://i.imgur.com/pHqnFmC.jpeg',
    'https://files.catbox.moe/5nddcl.jpg',
    'https://files.catbox.moe/ndvf4k.jpg',
    'https://files.catbox.moe/u7178f.jpg',
    'https://files.catbox.moe/gkek17.jpg',
    'https://files.catbox.moe/9drm3j.jpg',
    'https://files.catbox.moe/g3qybv.jpg',
    'https://files.catbox.moe/em2859.jpg',
  ],

  // ── Style 7 : Ruby Oshino ──────────────────────────────────
  7: [
    'https://i.imgur.com/zLaT5KT.jpeg',
    'https://i.imgur.com/A5cMbwA.jpeg',
    'https://i.imgur.com/mkrmEQf.jpeg',
   'https://files.catbox.moe/gqf5ba.jpg',
   'https://files.catbox.moe/jfzlre.jpg',
   'https://files.catbox.moe/whmaf8.jpg',
   'https://files.catbox.moe/rgbyxa.jpg',
   'https://files.catbox.moe/61axnd.jpg',
  ],

  // ── Style 8 : Satoru Gojo ──────────────────────────────────
  8: [
    'https://i.imgur.com/VgmhBaZ.jpeg',
    'https://i.imgur.com/GwnNj7R.jpeg',
    'https://i.imgur.com/wXsUEab.jpeg',
     'https://files.catbox.moe/xp5ypp.jpg',
     'https://files.catbox.moe/pbzdh3.jpeg',
     'https://files.catbox.moe/tf954v.jpg',
     'https://files.catbox.moe/eb9tg6.jpg',
    'https://files.catbox.moe/rgbyxa.jpg',
  ],

  // ── Style 9 : Oreki Houtarou ───────────────────────────────
  9: [
    'https://i.imgur.com/hIiPCsY.jpeg',
    'https://i.imgur.com/mJqzPJl.jpeg',
    'https://i.imgur.com/wXrNGFp.jpeg',
    'https://files.catbox.moe/brtvxo.jpg',
    'https://files.catbox.moe/jtvqys.jpg',
    'https://files.catbox.moe/8vh1vn.jpg',
     'https://files.catbox.moe/qddrjg.jpg',
    'https://files.catbox.moe/zsmflt.jpg',
  ],

  // ── Style 10 : Marin Kitagawa ──────────────────────────────
  10: [
    'https://i.imgur.com/4sMVZaB.jpeg',
    'https://i.imgur.com/9t2i4VK.jpeg',
    'https://i.imgur.com/v8BByTt.jpeg',
    'https://files.catbox.moe/xxgh2f.jpg',
    'https://files.catbox.moe/w4kcey.jpg',
    'https://files.catbox.moe/a7rh4y.jpg',
    'https://files.catbox.moe/oe68x7.jpg',
    'https://files.catbox.moe/fabbon.jpg',
  ],

  // ── Style 11 : Sung Jin-Woo ─────────────────────────────────
  // TODO : Remplacer par l'URL de l'image officielle du Style 11
  11: [
    '',
  ],

  // ── Style 12 : Madara Uchiha ────────────────────────────────
  // TODO : Remplacer par l'URL de l'image officielle du Style 12
  12: [
    '',
  ],

  // ── Style 13 : Aizen Sosuke ─────────────────────────────────
  // TODO : Remplacer par l'URL de l'image officielle du Style 13
  13: [
    '',
  ],

  // ── Style 14 : Lelouch Lamperouge ───────────────────────────
  // TODO : Remplacer par l'URL de l'image officielle du Style 14
  14: [
    '',
  ],

  // ── Style 15 : Eren Yeager ──────────────────────────────────
  // TODO : Remplacer par l'URL de l'image officielle du Style 15
  15: [
    '',
  ],

  // ── Style 16 : Itachi Uchiha ────────────────────────────────
  // TODO : Remplacer par l'URL de l'image officielle du Style 16
  16: [
    '',
  ],

  // ── Style 17 : Yhwach ───────────────────────────────────────
  // TODO : Remplacer par l'URL de l'image officielle du Style 17
  17: [
    '',
  ],

  // ── Style 18 : Business Pro ─────────────────────────────────
  // TODO : Remplacer par l'URL de l'image officielle du Style 18
  18: [
    '',
  ],

  // ── Style 19 : Shadow Merchant ──────────────────────────────
  // TODO : Remplacer par l'URL de l'image officielle du Style 19
  19: [
    '',
  ],

  // ── Style 20 : Purgeur Suprême ──────────────────────────────
  // TODO : Remplacer par l'URL de l'image officielle du Style 20
  20: [
    '',
  ],
};

// ── Télécharge l'image URL → Buffer (avec timeout 10s) ──
// Récupère une image personnalisée depuis une URL unique (menu personnalisé).
// Même logique de fetch que getImageBufferForStyle, appliquée à une seule URL.
async function getImageBufferFromUrl(url) {
  if (!url || !url.startsWith('http')) return null;
  const axios = require('axios');
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (res.data && res.data.byteLength > 1000) {
      return Buffer.from(res.data);
    }
  } catch (_) {
    // Image personnalisée invalide/inaccessible → repli sur l'image du style
  }
  return null;
}

async function getImageBufferForStyle(styleNum) {
  const axios = require('axios');
  // Filtrer les entrées vides/commentées
  const urls = (STYLE_IMAGE_URLS[styleNum] || STYLE_IMAGE_URLS[1]).filter(u => u && u.startsWith('http'));
  if (urls.length === 0) return null;
  // Choisir une URL au hasard
  const shuffled = [...urls].sort(() => Math.random() - 0.5);
  for (const url of shuffled) {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (res.data && res.data.byteLength > 1000) {
        return Buffer.from(res.data);
      }
    } catch (_) {
      // Essaie l'URL suivante si celle-ci échoue
    }
  }
  return null; // Toutes les URLs ont échoué → menu en texte
}

// ── Définitions des styles ──
const STYLES = {
  0: {
    nom: 'DIPPER',
    header: (b,o,r,p,c) =>
      `✦───────────────────✦\n   ⭐ *${b}* ⭐\n✦───────────────────✦\n┃ 👤 *ᴜᴛɪʟɪsᴀᴛᴇᴜʀ* : ${toSmallCaps(o)}\n┃ 🎖️ *ʀᴀɴɢ* : ${r}\n┃ ⌁ *ᴘʀᴇ́ꜰɪxᴇ* : [ *${p}* ]\n┃ 📜 *ᴍᴏᴅᴜʟᴇs* : ${c}\n✦───────────────────✦\n\n_"sᴇᴘᴛ ᴇ́ᴛᴏɪʟᴇs, ᴜɴᴇ sᴇᴜʟᴇ ᴅɪʀᴇᴄᴛɪᴏɴ."_ ⭐\n\n`,
    catOpen:  cat => `┌─── ${cat} ───┐\n`,
    catCmd:   cmd => `│ ⋆ *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `└──────────────────────┘\n\n`,
    footer: () => `⭐ *ʟ'ᴇ́ᴛᴏɪʟᴇ ǫᴜɪ ɢᴜɪᴅᴇ* ✦\n\n> *✦ ᴘᴀʀ 𝐃𝐈𝐏𝐏𝐄𝐑*`,
  },
  1: {
    nom: '𝐃𝐚𝐫𝐤',
    header: (b,o,r,p,c) =>
      `╭╼━≪• *${b}* •≫━╾╮\n┃ 🔮 *ᴠɪɢɪʟᴀɴᴄᴇ* : 🟢\n┃ 👤 *ᴘᴇ̀ʟᴇʀɪɴ* : ${toSmallCaps(o)}\n┃ ⚜️ *ʀᴀɴɢ* : ${r}\n┃ ⚡ *ɪɴᴄᴀɴᴛᴀᴛɪᴏɴ* : [ *${p}* ]\n┃ 📜 *ᴀʀᴄᴀɴᴇs* : ${c}\n╰━━━━━━━━━━━━━━━━━╯\n\n`,
    catOpen:  cat => `*╭╼≪• ${cat} •≫╾╮*\n`,
    catCmd:   cmd => `┃➻ *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `*╰━━━━━━━━━━━━━━━━━╯*\n\n`,
    footer: () => `_*♛ ᴊᴇsᴜs ᴇsᴛ ʀᴏɪ 𓆩✞𓆪*_\n\n> *♰ ᴇ́ᴛᴀʙʟɪ ᴘᴀʀ 𝐃𝐈𝐏𝐏𝐄𝐑 ♰*`,
  },
  2: {
    nom: 'Naruto',
    header: (b,o,r,p,c) =>
      `「 🍃 *ᴋᴏɴᴏʜᴀɢᴀᴋᴜʀᴇ* 🍃 」\n╔══✦ *${b}* ✦══╗\n║ 🌀 *sʜɪɴᴏʙɪ* : ${toSmallCaps(o)}\n║ 🎴 *ʀᴀɴɢ* : ${r}\n║ 🔱 *ᴊᴜᴛsᴜ* : [ *${p}* ]\n║ 📯 *ᴛᴇᴄʜɴɪǫᴜᴇs* : ${c}\n╚══════════════════╝\n\n_"ᴅᴀᴛᴛᴇʙᴀʏᴏ !"_ 🌀\n\n`,
    catOpen:  cat => `┌──✦ ${cat} ✦──┐\n`,
    catCmd:   cmd => `│⚡ *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `└─────────────────┘\n\n`,
    footer: () => `🍃 *ᴛʜᴇ ᴡɪʟʟ ᴏꜰ ꜰɪʀᴇ* 🔥\n\n> *🌀 ʙʏ 𝐃𝐈𝐏𝐏𝐄𝐑 × Naruto*`,
  },
  3: {
    nom: 'Cid Kagenou',
    header: (b,o,r,p,c) =>
      `◈━━━━━━━━━━━━━━◈\n   🕶️ *Ｔｈｅ　Ｓｈａｄｏｗ*\n◈━━━━━━━━━━━━━━◈\n▸ 🖤 *ɴᴏᴍ* : ${b}\n▸ 👁️ *ᴀɢᴇɴᴛ* : ${toSmallCaps(o)}\n▸ 💀 *ʀᴀɴɢ* : ${r}\n▸ 🗡️ *ᴄᴏᴅᴇ* : [ *${p}* ]\n◈━━━━━━━━━━━━━━◈\n\n_"ɪ ᴀᴍ... ᴛʜᴇ sʜᴀᴅᴏᴡ"_ 🖤\n\n`,
    catOpen:  cat => `◤━━ ${cat} ━━◥\n`,
    catCmd:   cmd => `  🕶️ *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `◣━━━━━━━━━━━━━━◢\n\n`,
    footer: () => `🖤 *ᴛʜᴇ sʜᴀᴅᴏᴡ ʀᴇɪɢɴs* 🌑\n\n> *🕶️ ʙʏ 𝐃𝐈𝐏𝐏𝐄𝐑 × Cid*`,
  },
  4: {
    nom: 'Hacker',
    header: (b,o,r,p,c) =>
      `\`\`\`\n[SYS] BOT=${b}\n[USR] ${o}\n[ACC] ${r}\n[PFX] ${p}\n[MOD] ${c} loaded\n\`\`\`\n\n💻 *[ACCESS GRANTED]* 🔓\n\n`,
    catOpen:  cat => `\`\`\`\n[${cat}]\n\`\`\`\n`,
    catCmd:   cmd => `💾 *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `\n`,
    footer: () => `\`\`\`\n[EOF] NOMINAL\n\`\`\`\n\n> *💻 ʙʏ 𝐃𝐈𝐏𝐏𝐄𝐑 × Hacker*`,
  },
  5: {
    nom: 'Manhwa',
    header: (b,o,r,p,c) =>
      `⚔️ ═══════════════ ⚔️\n     📖 *${b}*\n⚔️ ═══════════════ ⚔️\n🏹 *ʜᴜɴᴛᴇʀ* : ${toSmallCaps(o)}\n🔮 *ʀᴀɴɢ* : ${r}\n⚡ *sᴋɪʟʟ* : [ *${p}* ]\n📜 *ǫᴜᴇsᴛs* : ${c}\n⚔️ ═══════════════ ⚔️\n\n_"ʟᴇᴠᴇʟ ᴜᴘ ᴇᴠᴇʀʏ ᴅᴀʏ"_ ⬆️\n\n`,
    catOpen:  cat => `⟪ ${cat} ⟫\n`,
    catCmd:   cmd => `  ⚔️ *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `════════════════════\n\n`,
    footer: () => `💎 *ʟᴇᴠᴇʟ ᴜᴘ* ⚔️\n\n> *📖 ʙʏ 𝐃𝐈𝐏𝐏𝐄𝐑 × Manhwa*`,
  },
  6: {
    nom: 'Ai Oshino',
    header: (b,o,r,p,c) =>
      `✦˚｡🌟˚｡✦\n⭐ *${b}* ⭐\n✦˚｡🌟˚｡✦\n\n⭐ *ɪᴅᴏʟ* : ${toSmallCaps(o)}\n🎤 *ʀᴀɴɢ* : ${r}\n✨ *sᴄᴇ̀ɴᴇ* : [ *${p}* ]\n🎵 *sᴏɴɢs* : ${c}\n💛 *ᴀɢᴇɴᴄᴇ* : B-Komachi\n✦˚｡━━━━━━━━˚｡✦\n\n_"ʟ'ᴀᴍᴏᴜʀ ᴠᴇ́ʀɪᴛᴀʙʟᴇ"_ ⭐\n\n`,
    catOpen:  cat => `✨ ── ${cat} ── ✨\n`,
    catCmd:   cmd => `  ⭐ *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `⭐━━━━━━━━━━━━━━⭐\n\n`,
    footer: () => `⭐ *ᴛʜᴇ ᴛʀᴜᴇ ɪᴅᴏʟ* 💛\n\n> *⭐ ʙʏ 𝐃𝐈𝐏𝐏𝐄𝐑 × Ai Oshino*`,
  },
  7: {
    nom: 'Ruby Oshino',
    header: (b,o,r,p,c) =>
      `🩷══✿══🩷══✿══🩷\n💗 *${b}* 💗\n🩷══✿══🩷══✿══🩷\n\n🌸 *ɪᴅᴏʟ* : ${toSmallCaps(o)}\n💫 *ʀᴀɴɢ* : ${r}\n🎤 *sᴄᴇ̀ɴᴇ* : [ *${p}* ]\n🌺 *sᴏɴɢs* : ${c}\n🩷═══════════════🩷\n\n_"ʙʀɪʟʟᴇʀ ᴘʟᴜs !"_ 💗\n\n`,
    catOpen:  cat => `🌸 ── ${cat} ── 🌸\n`,
    catCmd:   cmd => `  💗 *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `🩷━━━━━━━━━━━━━━🩷\n\n`,
    footer: () => `💗 *sʜɪɴᴇ ʙʀɪɢʜᴛᴇʀ* 🌟\n\n> *🌸 ʙʏ 𝐃𝐈𝐏𝐏𝐄𝐑 × Ruby*`,
  },
  8: {
    nom: 'Satoru Gojo',
    header: (b,o,r,p,c) =>
      `━━━∞👁️∞━━━\n  *${b}*\n━━━∞👁️∞━━━\n\n👁️ *sᴏʀᴄɪᴇʀ* : ${toSmallCaps(o)}\n💙 *ʀᴀɴɢ* : ${r}\n♾️ *ᴛᴇᴄʜ* : [ *${p}* ]\n🔵 *ᴊᴜᴛsᴜs* : ${c}\n━━━∞👁️∞━━━\n\n_"ᴇᴠɪʟ ᴅᴏᴇsɴ'ᴛ sᴛᴀɴᴅ ᴀ ᴄʜᴀɴᴄᴇ"_ 👁️\n\n`,
    catOpen:  cat => `∞━━ ${cat} ━━∞\n`,
    catCmd:   cmd => `  👁️ *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `∞━━━━━━━━━━━━━━∞\n\n`,
    footer: () => `👁️ *ʜᴏɴᴏᴜʀᴇᴅ ᴏɴᴇ* ♾️\n\n> *👁️ ʙʏ 𝐃𝐈𝐏𝐏𝐄𝐑 × Gojo*`,
  },
  9: {
    nom: 'Oreki Houtarou',
    header: (b,o,r,p,c) =>
      `... 🌿\n  *${b}*\n— ᴇɴᴇʀɢʏ sᴀᴠɪɴɢ ᴍᴏᴅᴇ —\n\n📚 *ᴜsᴇʀ* : ${toSmallCaps(o)}\n🍵 *ʀᴀɴɢ* : ${r}\n🌿 *ᴄᴍᴅ* : [ *${p}* ]\n📖 *ᴍᴏᴅᴜʟᴇs* : ${c}\n— ─────────────── —\n\n_"ɪꜰ ɪ ʜᴀᴠᴇ ᴛᴏ, ɪ'ʟʟ ᴍᴀᴋᴇ ɪᴛ ǫᴜɪᴄᴋ"_ 🌿\n\n`,
    catOpen:  cat => `— ${cat}\n`,
    catCmd:   cmd => `  📚 *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `— ─────────────────\n\n`,
    footer: () => `🌿 *ʀᴏsʏ-ᴄᴏʟᴏᴜʀᴇᴅ* 🍵\n\n> *🌿 ʙʏ 𝐃𝐈𝐏𝐏𝐄𝐑 × Oreki*`,
  },
  10: {
    nom: 'Marin Kitagawa',
    header: (b,o,r,p,c) =>
      `🎀～～～～～～🎀\n🌸 *${b}* 🌸\n🎀～～～～～～🎀\n\n🎀 *ᴄᴏsᴘʟᴀʏᴇᴜsᴇ* : ${toSmallCaps(o)}\n💄 *ʀᴀɴɢ* : ${r}\n🧵 *sᴛʏʟᴇ* : [ *${p}* ]\n👗 *ᴄᴏsᴛᴜᴍᴇs* : ${c}\n🎀～～～～～～🎀\n\n_"ᴄ'ᴇsᴛ ʟᴇ ᴄᴏsᴘʟᴀʏ !"_ 🎀\n\n`,
    catOpen:  cat => `🌸 ── ${cat} ── 🌸\n`,
    catCmd:   cmd => `  🎀 *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `🎀～～～～～～～🎀\n\n`,
    footer: () => `🌸 *sʜɪɴᴇ* 💄\n\n> *🎀 ʙʏ 𝐃𝐈𝐏𝐏𝐄𝐑 × Marin*`,
  },
  11: {
    nom: 'Sung Jin-Woo',
    header: (b,o,r,p,c) =>
      `╔═〔 🩸 *${b}* 🩸 〕═╗\n║ ☠️ *ᴘʟᴀʏᴇʀ* : ${toSmallCaps(o)}\n║ 🗡️ *ʀᴀɴɢ* : ${r}\n║ ⚔️ *sᴋɪʟʟ* : [ *${p}* ]\n║ 📜 *ᴏᴍʙʀᴇs* : ${c}\n╚══════════════════╝\n\n_"ᴀʀɪsᴇ."_ 🩸\n\n`,
    catOpen:  cat => `▓▓ ${cat} ▓▓\n`,
    catCmd:   cmd => `  🩸 *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `▓▓▓▓▓▓▓▓▓▓▓▓▓▓\n\n`,
    footer: () => `> *🩸 ᴊᴇ ᴍᴀʀᴄʜᴇ sᴇᴜʟ ᴅᴀɴs ʟ'ᴏᴍʙʀᴇ — 𝐃𝐈𝐏𝐏𝐄𝐑 × Jin-Woo*`,
  },
  12: {
    nom: 'Madara Uchiha',
    header: (b,o,r,p,c) =>
      `◆━━━━━━━━━━━━━◆\n  🌑 *${b}* 🌑\n◆━━━━━━━━━━━━━◆\n▸ 🎭 *ᴜᴄʜɪʜᴀ* : ${toSmallCaps(o)}\n▸ 💀 *ʀᴀɴɢ* : ${r}\n▸ ♟️ *ᴊᴜᴛsᴜ* : [ *${p}* ]\n▸ 👁️ *ᴛᴇᴄʜɴɪǫᴜᴇs* : ${c}\n◆━━━━━━━━━━━━━◆\n\n_"ʟᴀ ᴠᴏʟᴏɴᴛᴇ́ ᴅ'ᴜɴ ᴅɪᴇᴜ ɴᴇ sᴇ ᴅɪsᴄᴜᴛᴇ ᴘᴀs."_ 🌑\n\n`,
    catOpen:  cat => `◆── ${cat} ──◆\n`,
    catCmd:   cmd => `  🌑 *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `◆━━━━━━━━━━━━━━◆\n\n`,
    footer: () => `> *🌑 ʟ'ᴇ́ᴠᴇɪʟ ᴅᴜ ʀɪɴɴᴇɢᴀɴ — 𝐃𝐈𝐏𝐏𝐄𝐑 × Madara*`,
  },
  13: {
    nom: 'Aizen Sosuke',
    header: (b,o,r,p,c) =>
      `🪷～━━━━━━━━━━━🪷\n  *${b}*\n🪷～━━━━━━━━━━━🪷\n🌸 *ᴄᴀᴘɪᴛᴀɪɴᴇ* : ${toSmallCaps(o)}\n💠 *ʀᴀɴɢ* : ${r}\n🗡️ *ᴢᴀɴᴘᴀᴋᴜᴛᴏ̄* : [ *${p}* ]\n📖 *ᴛᴇᴄʜɴɪǫᴜᴇs* : ${c}\n🪷～━━━━━━━━━━━🪷\n\n_"ᴛᴏᴜᴛ sᴇ ᴘᴀssᴇ ᴄᴏᴍᴍᴇ ᴘʀᴇ́ᴠᴜ."_ 🪷\n\n`,
    catOpen:  cat => `🪷 ── ${cat} ── 🪷\n`,
    catCmd:   cmd => `  🌸 *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `🪷━━━━━━━━━━━━━🪷\n\n`,
    footer: () => `> *🪷 ʟ'ɪɴᴄᴀʀɴᴀᴛɪᴏɴ ᴅᴇ ʟ'ᴀᴍʙɪᴛɪᴏɴ — 𝐃𝐈𝐏𝐏𝐄𝐑 × Aizen*`,
  },
  14: {
    nom: 'Lelouch Lamperouge',
    header: (b,o,r,p,c) =>
      `♔━━━━━━━━━━━━♔\n  👁️ *${b}*\n♔━━━━━━━━━━━━♔\n▸ 🎭 *sᴛʀᴀᴛᴇ̀ɢᴇ* : ${toSmallCaps(o)}\n▸ ♔ *ʀᴀɴɢ* : ${r}\n▸ 👁️ *ɢᴇᴀss* : [ *${p}* ]\n▸ 📋 *ᴏʀᴅʀᴇs* : ${c}\n♔━━━━━━━━━━━━♔\n\n_"ᴢᴇʀᴏ ᴏʀᴅᴏɴɴᴇ, ʟᴇ ᴍᴏɴᴅᴇ ᴏʙᴇ́ɪᴛ."_ ♔\n\n`,
    catOpen:  cat => `♔── ${cat} ──♔\n`,
    catCmd:   cmd => `  👁️ *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `♔━━━━━━━━━━━━━━♔\n\n`,
    footer: () => `> *👁️ ᴠɪᴠᴀ ʟᴀ ʀᴇ́ᴠᴏʟᴜᴛɪᴏɴ — 𝐃𝐈𝐏𝐏𝐄𝐑 × Lelouch*`,
  },
  15: {
    nom: 'Eren Yeager',
    header: (b,o,r,p,c) =>
      `⛓️━━━━━━━━━━━⛓️\n  ⚡ *${b}*\n⛓️━━━━━━━━━━━⛓️\n▸ 🪖 *sᴏʟᴅᴀᴛ* : ${toSmallCaps(o)}\n▸ ⚡ *ʀᴀɴɢ* : ${r}\n▸ ⛓️ *ᴛɪᴛᴀɴ* : [ *${p}* ]\n▸ 🗺️ *ᴍɪssɪᴏɴs* : ${c}\n⛓️━━━━━━━━━━━⛓️\n\n_"ᴊᴇ ᴄᴏɴᴛɪɴᴜᴇʀᴀɪ ᴅ'ᴀᴠᴀɴᴄᴇʀ."_ ⚡\n\n`,
    catOpen:  cat => `⛓️ ── ${cat} ── ⛓️\n`,
    catCmd:   cmd => `  ⚡ *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `⛓️━━━━━━━━━━━━━⛓️\n\n`,
    footer: () => `> *⚡ ᴊᴇ ᴄᴏɴᴛɪɴᴜᴇʀᴀɪ ᴅ'ᴀᴠᴀɴᴄᴇʀ — 𝐃𝐈𝐏𝐏𝐄𝐑 × Eren*`,
  },
  16: {
    nom: 'Itachi Uchiha',
    header: (b,o,r,p,c) =>
      `🪄━━━━━━━━━━━━🪄\n  👁️ *${b}*\n🪄━━━━━━━━━━━━🪄\n▸ 🍥 *ᴀɴʙᴜ* : ${toSmallCaps(o)}\n▸ 🪄 *ʀᴀɴɢ* : ${r}\n▸ 👁️ *ᴅᴏᴊᴜᴛsᴜ* : [ *${p}* ]\n▸ 📜 *ᴛᴇᴄʜɴɪǫᴜᴇs* : ${c}\n🪄━━━━━━━━━━━━🪄\n\n_"ᴛᴏᴜᴛ sᴀᴄʀɪꜰɪᴄᴇ ᴀ ᴜɴ sᴇɴs."_ 👁️\n\n`,
    catOpen:  cat => `🪄── ${cat} ──🪄\n`,
    catCmd:   cmd => `  👁️ *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `🪄━━━━━━━━━━━━━━🪄\n\n`,
    footer: () => `> *🪄 ᴘᴀʀᴅᴏɴɴᴇ-ᴍᴏɪ, sᴀsᴜᴋᴇ — 𝐃𝐈𝐏𝐏𝐄𝐑 × Itachi*`,
  },
  17: {
    nom: 'Yhwach',
    header: (b,o,r,p,c) =>
      `☩━━━━━━━━━━━━☩\n  *${b}*\n☩━━━━━━━━━━━━☩\n▸ ⛪ *Qᴜɪɴᴄʏ* : ${toSmallCaps(o)}\n▸ ☩ *ʀᴀɴɢ* : ${r}\n▸ 👑 *Almighty* : [ *${p}* ]\n▸ 📖 *ᴠɪsɪᴏɴs* : ${c}\n☩━━━━━━━━━━━━☩\n\n_"ᴊ'ᴀɪ ᴅᴇ́ᴊᴀ̀ ᴠᴜ ᴄᴇᴛ ᴀᴠᴇɴɪʀ."_ ☩\n\n`,
    catOpen:  cat => `☩── ${cat} ──☩\n`,
    catCmd:   cmd => `  ☩ *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `☩━━━━━━━━━━━━━━☩\n\n`,
    footer: () => `> *☩ ʟᴇ ᴘᴇ̀ʀᴇ ᴅᴇs Qᴜɪɴᴄʏ — 𝐃𝐈𝐏𝐏𝐄𝐑 × Yhwach*`,
  },
  18: {
    nom: 'Business Pro',
    header: (b,o,r,p,c) =>
      `┌─────────────────┐\n│  💼 ${b}\n├─────────────────┤\n│ 👤 Utilisateur : ${o}\n│ 📋 Rang : ${r}\n│ ⚙️ Préfixe : [ ${p} ]\n│ 📊 Modules : ${c}\n└─────────────────┘\n\n_"L'efficacité, sans compromis."_ 💼\n\n`,
    catOpen:  cat => `▸ ${cat}\n`,
    catCmd:   cmd => `  • ${cmd.name}\n`,
    catClose: ()  => `\n`,
    footer: () => `> *💼 𝐃𝐈𝐏𝐏𝐄𝐑 Business — ᴠᴏᴛʀᴇ ᴀssɪsᴛᴀɴᴛ ᴄᴏᴍᴍᴇʀᴄɪᴀʟ*`,
  },
  19: {
    nom: 'Shadow Merchant',
    header: (b,o,r,p,c) =>
      `🕯️━━━━━━━━━━━━🕯️\n  🌒 *${b}*\n🕯️━━━━━━━━━━━━🕯️\n▸ 🧥 *ᴄʟɪᴇɴᴛ* : ${toSmallCaps(o)}\n▸ 🌒 *ʀᴀɴɢ* : ${r}\n▸ 🕯️ *ᴄᴏᴅᴇ* : [ *${p}* ]\n▸ 📦 *ᴍᴀʀᴄʜᴀɴᴅɪsᴇs* : ${c}\n🕯️━━━━━━━━━━━━🕯️\n\n_"ᴛᴏᴜᴛ sᴇ ɴᴇ́ɢᴏᴄɪᴇ, ᴅᴀɴs ʟ'ᴏᴍʙʀᴇ."_ 🌒\n\n`,
    catOpen:  cat => `🕯️── ${cat} ──🕯️\n`,
    catCmd:   cmd => `  🌒 *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `🕯️━━━━━━━━━━━━━━🕯️\n\n`,
    footer: () => `> *🌒 ʟ'ᴏᴍʙʀᴇ ᴛʀᴀꜰɪǫᴜᴇ — 𝐃𝐈𝐏𝐏𝐄𝐑 × Sʜᴀᴅᴏᴡ*`,
  },
  20: {
    nom: 'Purgeur Suprême',
    header: (b,o,r,p,c) =>
      `🔥━━━━━━━━━━━━🔥\n  ☄️ *${b}*\n🔥━━━━━━━━━━━━🔥\n▸ ⚔️ *ᴘᴜʀɢᴇᴜʀ* : ${toSmallCaps(o)}\n▸ 🔥 *ʀᴀɴɢ* : ${r}\n▸ ☄️ *ᴏʀᴅʀᴇ* : [ *${p}* ]\n▸ 📜 *ᴘᴜʀɢᴇs* : ${c}\n🔥━━━━━━━━━━━━🔥\n\n_"ʟᴀ ᴘᴜʀɢᴇ ɴ'ᴇ́ᴘᴀʀɢɴᴇ ᴘᴇʀsᴏɴɴᴇ."_ 🔥\n\n`,
    catOpen:  cat => `🔥── ${cat} ──🔥\n`,
    catCmd:   cmd => `  ☄️ *${toBSC(cmd.name)}*\n`,
    catClose: ()  => `🔥━━━━━━━━━━━━━━🔥\n\n`,
    footer: () => `> *🔥 ʟᴀ ᴘᴜʀɢᴇ ᴇsᴛ ᴇ́ᴛᴇʀɴᴇʟʟᴇ — 𝐃𝐈𝐏𝐏𝐄𝐑 × ᴘᴜʀɢᴇᴜʀ*`,
  },
};

const STYLE_CONFIRM = {
  0:  `╭━≪• *⭐ sᴛʏʟᴇ DIPPER ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ ✦ ʟ'ɪᴅᴇɴᴛɪᴛᴇ́ ᴏꜰꜰɪᴄɪᴇʟʟᴇ ᴇsᴛ ʀᴇsᴛᴀᴜʀᴇ́ᴇ\n╰━━━━━━━━━━━━━━━━━╯`,
  1:  `╭━≪• *🔮 sᴛʏʟᴇ 𝐃𝐚𝐫𝐤 ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ ♰ sᴀɴᴄᴛᴜᴀɪʀᴇ ʀᴇsᴛᴀᴜʀᴇ́\n╰━━━━━━━━━━━━━━━━━╯`,
  2:  `╭━≪• *🌀 sᴛʏʟᴇ Naruto ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ 🍃 ᴅᴀᴛᴛᴇʙᴀʏᴏ !\n╰━━━━━━━━━━━━━━━━━╯`,
  3:  `╭━≪• *🕶️ sᴛʏʟᴇ Cid ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ 🖤 ʟ'ᴏᴍʙʀᴇ ᴘʀᴇɴᴅ ʟᴇ ᴄᴏɴᴛʀᴏ̂ʟᴇ\n╰━━━━━━━━━━━━━━━━━╯`,
  4:  `╭━≪• *💻 sᴛʏʟᴇ Hacker ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ 🔓 [ACCESS GRANTED]\n╰━━━━━━━━━━━━━━━━━╯`,
  5:  `╭━≪• *⚔️ sᴛʏʟᴇ Manhwa ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ 📖 ʜᴜɴᴛᴇʀ ᴇ́ᴠᴇɪʟʟᴇ́\n╰━━━━━━━━━━━━━━━━━╯`,
  6:  `╭━≪• *⭐ sᴛʏʟᴇ Ai Oshino ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ 💛 ɪᴅᴏʟᴇ ʙʀɪʟʟᴇ\n╰━━━━━━━━━━━━━━━━━╯`,
  7:  `╭━≪• *💗 sᴛʏʟᴇ Ruby ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ 🌸 ᴇ́ᴛᴏɪʟᴇ ᴍᴏɴᴛᴇ\n╰━━━━━━━━━━━━━━━━━╯`,
  8:  `╭━≪• *👁️ sᴛʏʟᴇ Gojo ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ ♾️ ɪɴꜰɪɴɪᴛʏ ᴇɴɢʟᴏʙᴇ ᴛᴏᴜᴛ\n╰━━━━━━━━━━━━━━━━━╯`,
  9:  `╭━≪• *🌿 sᴛʏʟᴇ Oreki ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ 📚 ᴍɪɴɪᴍᴜᴍ ᴅ'ᴇ́ɴᴇʀɢɪᴇ\n╰━━━━━━━━━━━━━━━━━╯`,
  10: `╭━≪• *🎀 sᴛʏʟᴇ Marin ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ 🌸 ᴄᴏsᴘʟᴀʏᴇᴜsᴇ ᴘʀᴇ̂ᴛᴇ\n╰━━━━━━━━━━━━━━━━━╯`,
  11: `╭━≪• *🩸 sᴛʏʟᴇ Jin-Woo ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ ☠️ ᴀʀɪsᴇ\n╰━━━━━━━━━━━━━━━━━╯`,
  12: `╭━≪• *🌑 sᴛʏʟᴇ Madara ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ ♟️ ʟᴀ ᴠᴏʟᴏɴᴛᴇ́ ᴅ'ᴜɴ ᴅɪᴇᴜ\n╰━━━━━━━━━━━━━━━━━╯`,
  13: `╭━≪• *🪷 sᴛʏʟᴇ Aizen ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ 🌸 ᴛᴏᴜᴛ sᴇ ᴘᴀssᴇ ᴄᴏᴍᴍᴇ ᴘʀᴇ́ᴠᴜ\n╰━━━━━━━━━━━━━━━━━╯`,
  14: `╭━≪• *👁️ sᴛʏʟᴇ Lelouch ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ ♔ ᴠɪᴠᴀ ʟᴀ ʀᴇ́ᴠᴏʟᴜᴛɪᴏɴ\n╰━━━━━━━━━━━━━━━━━╯`,
  15: `╭━≪• *⚡ sᴛʏʟᴇ Eren ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ ⛓️ ᴊᴇ ᴄᴏɴᴛɪɴᴜᴇʀᴀɪ ᴅ'ᴀᴠᴀɴᴄᴇʀ\n╰━━━━━━━━━━━━━━━━━╯`,
  16: `╭━≪• *🪄 sᴛʏʟᴇ Itachi ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ 👁️ ᴛsᴜᴋᴜʏᴏᴍɪ\n╰━━━━━━━━━━━━━━━━━╯`,
  17: `╭━≪• *☩ sᴛʏʟᴇ Yhwach ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ 👑 Almighty\n╰━━━━━━━━━━━━━━━━━╯`,
  18: `╭━≪• *💼 sᴛʏʟᴇ Business Pro ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ 📊 Mode professionnel\n╰━━━━━━━━━━━━━━━━━╯`,
  19: `╭━≪• *🌒 sᴛʏʟᴇ Shadow Merchant ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ 🕯️ ʟᴇ ᴍᴀʀᴄʜᴇ́ ɴᴏᴄᴛᴜʀɴᴇ s'ᴏᴜᴠʀᴇ\n╰━━━━━━━━━━━━━━━━━╯`,
  20: `╭━≪• *🔥 sᴛʏʟᴇ Purgeur Suprême ᴀᴄᴛɪᴠᴇ́* •≫━╾╮\n┃ ☄️ ʟᴀ ᴘᴜʀɢᴇ ᴇsᴛ ᴇ́ᴛᴇʀɴᴇʟʟᴇ\n╰━━━━━━━━━━━━━━━━━╯`,
};

// ══════════════════════════════════════════════════════════════
// EN-TÊTE IMMERSIF — adapté à chaque thème
// ══════════════════════════════════════════════════════════════

// Salutation selon l'heure du Bénin (UTC+1)
function getGreeting() {
  const now   = new Date();
  const bj    = new Date(now.toLocaleString('fr-FR', { timeZone: 'Africa/Porto-Novo' }));
  const hour  = bj.getHours();
  if (hour >= 5  && hour < 12) return 'Bonjour 🌞';
  if (hour >= 12 && hour < 17) return 'Bon après-midi ☀️';
  if (hour >= 17 && hour < 21) return 'Bonsoir 🌙';
  return 'Bonne nuit 🌌';
}

// Heure formatée Bénin
function getTimeBenin() {
  return new Date().toLocaleTimeString('fr-FR', {
    timeZone: 'Africa/Porto-Novo',
    hour: '2-digit', minute: '2-digit',
  });
}

// Uptime lisible
function getUptime() {
  const s   = Math.floor(process.uptime());
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Latence estimée via Date.now() delta (disponible sans ping réel)
function getLatency() {
  const t1  = Date.now();
  let   sum = 0;
  for (let i = 0; i < 10000; i++) sum += i; // micro-benchmark local
  return Date.now() - t1; // quelques ms
}

// Nom d'affichage de l'utilisateur à partir de son JID
function formatUser(senderJid) {
  if (!senderJid) return '—';
  const num = senderJid.split('@')[0].split(':')[0];
  return `+${num.slice(0, 3)} ${num.slice(3, 6)} ${num.slice(6)}`.trim();
}

// ── Construire l'en-tête immersif — 10 styles thématiques ─────
function buildImmersiveHeader(style, senderJid, count, botName) {
  const greeting = getGreeting();
  const time     = getTimeBenin();
  const uptime   = getUptime();
  const bot      = botName || '𝐃𝐈𝐏𝐏𝐄𝐑';
  const owner    = '𝐌ꝛ⥔𝕿𝖗𝖊𝖘𝖔𝖗 🌹';
  const ver      = '1.0';
  const pfx      = prefix;
  const mention  = `@${(senderJid || '').split('@')[0].split(':')[0]}`;

  // ── Style 0 · DIPPER (identité officielle) ──────────────────
  if (style === 0) return (
    `✦━━━━━━━━━━━━━━━━━━━━✦\n` +
    `      ⭐ *${bot}* ⭐\n` +
    `✦━━━━━━━━━━━━━━━━━━━━✦\n\n` +
    `*${greeting}*, ${mention} ✦\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 📜 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `✦ _"𝑆𝑒𝑝𝑡 é𝑡𝑜𝑖𝑙𝑒𝑠, 𝑢𝑛𝑒 𝑠𝑒𝑢𝑙𝑒 𝑑𝑖𝑟𝑒𝑐𝑡𝑖𝑜𝑛."_ ✦\n\n`
  );

  // ── Style 1 · Dark ─────────────────────────────────────────
  if (style === 1) return (
    `♰━━━━━━━━━━━━━━━━━━━━♰\n` +
    `      🔮 *${bot}* 🔮\n` +
    `♰━━━━━━━━━━━━━━━━━━━━♰\n\n` +
    `*${greeting}*, ${mention} 👋\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 📜 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `♰ _"𝐿'𝑜𝑚𝑏𝑟𝑒 𝑒𝑠𝑡 𝑙à 𝑜ù 𝑛𝑎𝑖𝑡 𝑙𝑎 𝑣𝑟𝑎𝑖𝑒 𝑝𝑢𝑖𝑠𝑠𝑎𝑛𝑐𝑒."_ ♰\n\n`
  );

  // ── Style 2 · Naruto ───────────────────────────────────────
  if (style === 2) return (
    `🍃══════════════════🍃\n` +
    `   🌀 *${bot}* 🌀\n` +
    `🍃══════════════════🍃\n\n` +
    `*${greeting}*, ${mention} 🍃\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 📯 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `🌀 _"𝐷𝑎𝑡𝑡𝑒𝑏𝑎𝑦𝑜 ! 𝐿𝑒 𝑐ℎ𝑒𝑚𝑖𝑛 𝑑'𝑢𝑛 𝑛𝑖𝑛𝑗𝑎 𝑛'𝑒𝑠𝑡 𝑗𝑎𝑚𝑎𝑖𝑠 𝑓𝑎𝑐𝑖𝑙𝑒."_ 🍃\n\n`
  );

  // ── Style 3 · Cid Kagenou ──────────────────────────────────
  if (style === 3) return (
    `𓆩⚔︎━━━━━━━━━━━━━━⚔︎𓆪\n` +
    `    🕶️ *${bot}* 🕶️\n` +
    `𓆩⚔︎━━━━━━━━━━━━━━⚔︎𓆪\n\n` +
    `*${greeting}*, ${mention} 🖤\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 🗡️  *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `𓆩 _"𝐿'𝑜𝑚𝑏𝑟𝑒 𝑒𝑠𝑡 𝑚𝑎 𝑛𝑎𝑡𝑢𝑟𝑒. 𝐽𝑒 𝑠𝑢𝑖𝑠... 𝑇ℎ𝑒 𝑆ℎ𝑎𝑑𝑜𝑤."_ 𓆪\n\n`
  );

  // ── Style 4 · Hacker ───────────────────────────────────────
  if (style === 4) return (
    `\`\`\`\n` +
    `╔═══════════════════╗\n` +
    `║   [ ${bot} ]   ║\n` +
    `╚═══════════════════╝\n\n` +
    `[INF] ${greeting}, ${mention}\n\n` +
    `[USR] Usᴇʀ     » ${mention}\n` +
    `[OWN] Oᴡɴᴇʀ    » ${owner}\n` +
    `[CLK] Hᴇᴜʀᴇ    » ${time} BJ\n` +
    `[PFX] Pʀᴇғɪx   » ${pfx}\n` +
    `[VER] Vᴇʀsɪᴏɴ  » v${ver}\n` +
    `[UPT] Uᴘᴛɪᴍᴇ   » ${uptime}\n` +
    `[MOD] Cᴏᴍᴍᴀɴᴅs » ${count} loaded\n\n` +
    `"Every system can be penetrated."\n` +
    `\`\`\`\n\n`
  );

  // ── Style 5 · Manhwa ───────────────────────────────────────
  if (style === 5) return (
    `⚔️ ══════════════════ ⚔️\n` +
    `       📖 *${bot}*\n` +
    `⚔️ ══════════════════ ⚔️\n\n` +
    `*${greeting}*, ${mention} ⚡\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 📜 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `⚔️ _"𝐿𝑒𝑠 𝑝𝑜𝑟𝑡𝑒𝑠 𝑑𝑢 𝑑𝑜𝑛𝑗𝑜𝑛 𝑠'𝑜𝑢𝑣𝑟𝑒𝑛𝑡 𝑑𝑒𝑣𝑎𝑛𝑡 𝑐𝑒𝑢𝑥 𝑞𝑢𝑖 𝑎𝑠𝑐𝑒𝑛𝑑𝑒𝑛𝑡."_ ⚔️\n\n`
  );

  // ── Style 6 · Ai Oshino ────────────────────────────────────
  if (style === 6) return (
    `✦˚｡⭐━━━━━━━━━━━━⭐˚｡✦\n` +
    `     ⭐ *${bot}* ⭐\n` +
    `✦˚｡⭐━━━━━━━━━━━━⭐˚｡✦\n\n` +
    `*${greeting}*, ${mention} 💛\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 🎵 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `⭐ _"𝐿'𝑎𝑚𝑜𝑢𝑟 𝑣é𝑟𝑖𝑡𝑎𝑏𝑙𝑒 𝑒𝑠𝑡 𝑙𝑎 𝑠𝑒𝑢𝑙𝑒 𝑙𝑢𝑚𝑖è𝑟𝑒 𝑖𝑛𝑒𝑥𝑡𝑖𝑛𝑔𝑢𝑖𝑏𝑙𝑒."_ 💛\n\n`
  );

  // ── Style 7 · Ruby Oshino ──────────────────────────────────
  if (style === 7) return (
    `🩷══✿══════════════✿══🩷\n` +
    `      💗 *${bot}* 💗\n` +
    `🩷══✿══════════════✿══🩷\n\n` +
    `*${greeting}*, ${mention} 🌸\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 🌺 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `🌸 _"𝐿𝑒𝑠 é𝑡𝑜𝑖𝑙𝑒𝑠 𝑏𝑟𝑖𝑙𝑙𝑒𝑛𝑡 𝑑𝑎𝑛𝑠 𝑙𝑒𝑠 𝑦𝑒𝑢𝑥 𝑑𝑒 𝑐𝑒𝑢𝑥 𝑞𝑢𝑖 𝑝𝑜𝑢𝑟𝑠𝑢𝑖𝑣𝑒𝑛𝑡 𝑙𝑒𝑢𝑟𝑠 𝑟ê𝑣𝑒𝑠."_ 💗\n\n`
  );

  // ── Style 8 · Gojo Satoru ──────────────────────────────────
  if (style === 8) return (
    `━━━∞👁️∞━━━━━━━━━∞👁️∞━━━\n` +
    `       *${bot}*\n` +
    `━━━∞👁️∞━━━━━━━━━∞👁️∞━━━\n\n` +
    `*${greeting}*, ${mention} 👁️\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ ♾️  *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `👁️ _"𝑆𝑖 𝑡𝑢 𝑝𝑒𝑛𝑠𝑒𝑠 𝑎𝑡𝑡𝑒𝑖𝑛𝑑𝑟𝑒 𝑚𝑎 𝑙𝑖𝑚𝑖𝑡𝑒 — 𝑖𝑙 𝑛'𝑦 𝑒𝑛 𝑎 𝑝𝑎𝑠."_ ♾️\n\n`
  );

  // ── Style 9 · Oreki ────────────────────────────────────────
  if (style === 9) return (
    `— ─────────────────── —\n` +
    `   🌿 *${bot}* 🌿\n` +
    `  ᴇɴᴇʀɢʏ sᴀᴠɪɴɢ ᴍᴏᴅᴇ\n` +
    `— ─────────────────── —\n\n` +
    `*${greeting}*, ${mention} 🍵\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 📚 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `🌿 _"𝑆𝑖 𝑗𝑒 𝑙𝑒 𝑑𝑜𝑖𝑠, 𝑗𝑒 𝑙𝑒 𝑓𝑒𝑟𝑎𝑖 𝑣𝑖𝑡𝑒. 𝑃𝑎𝑠 𝑚𝑜𝑖𝑛𝑠, 𝑝𝑎𝑠 𝑝𝑙𝑢𝑠."_ 🍵\n\n`
  );

  // ── Style 10 · Marin Kitagawa ──────────────────────────────
  if (style === 10) return (
    `🎀～～～～～～～～～～～🎀\n` +
    `    🌸 *${bot}* 🌸\n` +
    `🎀～～～～～～～～～～～🎀\n\n` +
    `*${greeting}*, ${mention} 🎀\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 🧵 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `🎀 _"𝐿𝑒 𝑐𝑜𝑠𝑝𝑙𝑎𝑦 𝑐'𝑒𝑠𝑡 𝑝𝑙𝑢𝑠 𝑞𝑢'𝑢𝑛 𝑑é𝑔𝑢𝑖𝑠𝑒𝑚𝑒𝑛𝑡 — 𝑐'𝑒𝑠𝑡 𝑢𝑛𝑒 𝑑é𝑐𝑙𝑎𝑟𝑎𝑡𝑖𝑜𝑛 𝑑'𝑎𝑚𝑜𝑢𝑟."_ 🌺\n\n`
  );

  // ── Style 11 · Sung Jin-Woo ────────────────────────────────
  if (style === 11) return (
    `╔═〔 🩸 *${bot}* 🩸 〕═╗\n` +
    `╚══════════════════╝\n\n` +
    `*${greeting}*, ${mention} ☠️\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 📜 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `🩸 _"𝐴𝑟𝑖𝑠𝑒. 𝐿𝑒 𝑟𝑜𝑖 𝑑𝑒𝑠 𝑑𝑜𝑛𝑗𝑜𝑛𝑠 𝑛𝑒 𝑚𝑎𝑟𝑐ℎ𝑒 𝑗𝑎𝑚𝑎𝑖𝑠 𝑠𝑒𝑢𝑙 𝑏𝑖𝑒𝑛 𝑙𝑜𝑛𝑔𝑡𝑒𝑚𝑝𝑠."_ 🩸\n\n`
  );

  // ── Style 12 · Madara Uchiha ───────────────────────────────
  if (style === 12) return (
    `◆━━━━━━━━━━━━━◆\n` +
    `   🌑 *${bot}* 🌑\n` +
    `◆━━━━━━━━━━━━━◆\n\n` +
    `*${greeting}*, ${mention} 🌑\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 👁️  *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `🌑 _"𝐿𝑎 𝑣𝑜𝑙𝑜𝑛𝑡é 𝑑'𝑢𝑛 𝑑𝑖𝑒𝑢 𝑛𝑒 𝑠𝑒 𝑑𝑖𝑠𝑐𝑢𝑡𝑒 𝑝𝑎𝑠, 𝑒𝑙𝑙𝑒 𝑠'𝑖𝑚𝑝𝑜𝑠𝑒."_ ♟️\n\n`
  );

  // ── Style 13 · Aizen Sosuke ────────────────────────────────
  if (style === 13) return (
    `🪷～━━━━━━━━━━━🪷\n` +
    `     *${bot}*\n` +
    `🪷～━━━━━━━━━━━🪷\n\n` +
    `*${greeting}*, ${mention} 🪷\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 📖 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `🪷 _"𝑇𝑜𝑢𝑡 𝑠𝑒 𝑝𝑎𝑠𝑠𝑒 𝑒𝑥𝑎𝑐𝑡𝑒𝑚𝑒𝑛𝑡 𝑐𝑜𝑚𝑚𝑒 𝑝𝑟é𝑣𝑢, 𝑑𝑒𝑝𝑢𝑖𝑠 𝑙𝑒 𝑑é𝑏𝑢𝑡."_ 🌸\n\n`
  );

  // ── Style 14 · Lelouch Lamperouge ──────────────────────────
  if (style === 14) return (
    `♔━━━━━━━━━━━━♔\n` +
    `   👁️ *${bot}*\n` +
    `♔━━━━━━━━━━━━♔\n\n` +
    `*${greeting}*, ${mention} ♔\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 📋 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `♔ _"𝑍𝑒𝑟𝑜 𝑜𝑟𝑑𝑜𝑛𝑛𝑒, 𝑒𝑡 𝑙𝑒 𝑚𝑜𝑛𝑑𝑒 𝑜𝑏é𝑖𝑡."_ 👁️\n\n`
  );

  // ── Style 15 · Eren Yeager ─────────────────────────────────
  if (style === 15) return (
    `⛓️━━━━━━━━━━━⛓️\n` +
    `   ⚡ *${bot}*\n` +
    `⛓️━━━━━━━━━━━⛓️\n\n` +
    `*${greeting}*, ${mention} ⚡\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 🗺️  *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `⚡ _"𝐽𝑒 𝑐𝑜𝑛𝑡𝑖𝑛𝑢𝑒𝑟𝑎𝑖 𝑑'𝑎𝑣𝑎𝑛𝑐𝑒𝑟, 𝑞𝑢𝑜𝑖 𝑞𝑢'𝑖𝑙 𝑒𝑛 𝑐𝑜û𝑡𝑒."_ ⛓️\n\n`
  );

  // ── Style 16 · Itachi Uchiha ───────────────────────────────
  if (style === 16) return (
    `🪄━━━━━━━━━━━━🪄\n` +
    `   👁️ *${bot}*\n` +
    `🪄━━━━━━━━━━━━🪄\n\n` +
    `*${greeting}*, ${mention} 🪄\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 📜 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `👁️ _"𝑇𝑜𝑢𝑡 𝑠𝑎𝑐𝑟𝑖𝑓𝑖𝑐𝑒 𝑎 𝑢𝑛 𝑠𝑒𝑛𝑠, 𝑚ê𝑚𝑒 𝑑𝑎𝑛𝑠 𝑙'𝑜𝑚𝑏𝑟𝑒."_ 🪄\n\n`
  );

  // ── Style 17 · Yhwach ──────────────────────────────────────
  if (style === 17) return (
    `☩━━━━━━━━━━━━☩\n` +
    `     *${bot}*\n` +
    `☩━━━━━━━━━━━━☩\n\n` +
    `*${greeting}*, ${mention} ☩\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 📖 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `☩ _"𝐽'𝑎𝑖 𝑑é𝑗à 𝑣𝑢 𝑐𝑒𝑡 𝑎𝑣𝑒𝑛𝑖𝑟. 𝐼𝑙 𝑚'𝑎𝑝𝑝𝑎𝑟𝑡𝑖𝑒𝑛𝑡."_ 👑\n\n`
  );

  // ── Style 18 · Business Pro ────────────────────────────────
  if (style === 18) return (
    `┌─────────────────┐\n` +
    `│  💼 ${bot}\n` +
    `└─────────────────┘\n\n` +
    `${greeting}, ${mention}\n\n` +
    `➠ 👤 Utilisateur : ${mention}\n` +
    `➠ 👑 Propriétaire : ${owner}\n` +
    `➠ ⏰ Heure : ${time} (Bénin)\n` +
    `➠ ✦  Préfixe : ${pfx}\n` +
    `➠ 🏷️  Version : ${ver}\n` +
    `➠ ⚡ Uptime : ${uptime}\n` +
    `➠ 📊 Commandes : ${count}\n\n` +
    `💼 _"L'efficacité, sans compromis."_\n\n`
  );

  // ── Style 19 · Shadow Merchant ─────────────────────────────
  if (style === 19) return (
    `🕯️━━━━━━━━━━━━🕯️\n` +
    `   🌒 *${bot}*\n` +
    `🕯️━━━━━━━━━━━━🕯️\n\n` +
    `*${greeting}*, ${mention} 🌒\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 📦 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `🌒 _"𝑇𝑜𝑢𝑡 𝑠𝑒 𝑛é𝑔𝑜𝑐𝑖𝑒, 𝑑𝑎𝑛𝑠 𝑙'𝑜𝑚𝑏𝑟𝑒 𝑑𝑢 𝑚𝑎𝑟𝑐ℎé."_ 🕯️\n\n`
  );

  // ── Style 20 · Purgeur Suprême ─────────────────────────────
  if (style === 20) return (
    `🔥━━━━━━━━━━━━🔥\n` +
    `   ☄️ *${bot}*\n` +
    `🔥━━━━━━━━━━━━🔥\n\n` +
    `*${greeting}*, ${mention} 🔥\n\n` +
    `➠ 👤 *Usᴇʀ*     : ${mention}\n` +
    `➠ 👑 *Oᴡɴᴇʀ*    : ${owner}\n` +
    `➠ ⏰ *Hᴇᴜʀᴇ*    : ${time} (Bénin)\n` +
    `➠ ✦  *Pʀᴇғɪx*   : ${pfx}\n` +
    `➠ 🏷️  *Vᴇʀsɪᴏɴ* : ${ver}\n` +
    `➠ ⚡ *Uᴘᴛɪᴍᴇ*   : ${uptime}\n` +
    `➠ 📜 *Cᴏᴍᴍᴀɴᴅs* : ${count}\n\n` +
    `🔥 _"𝐿𝑎 𝑝𝑢𝑟𝑔𝑒 𝑛'é𝑝𝑎𝑟𝑔𝑛𝑒 𝑝𝑒𝑟𝑠𝑜𝑛𝑛𝑒, 𝑝𝑎𝑠 𝑚ê𝑚𝑒 𝑙𝑒 𝑡𝑒𝑚𝑝𝑠."_ ☄️\n\n`
  );

  // Filet de sécurité ultime : ne devrait plus jamais être atteint
  // maintenant que les 21 styles (0 et 1→20) ont chacun leur bannière.
  return buildImmersiveHeader(0, senderJid, count, botName);
}

// ══════════════════════════════════════════════════════════════
// 📋 NAVIGATION PAR CATÉGORIES — aperçu numéroté + réponse au menu
// ══════════════════════════════════════════════════════════════
// Signature finale du menu — le ">" en tête donne le rendu "citation"
// natif de WhatsApp.
const SIGNATURE = '\n>Powered by 🌹 𝐌ꝛ⥔𝕿𝖗𝖊𝖘𝖔𝖗 🌹';

// Ordre d'affichage fixe des catégories — ne dépend jamais de l'ordre de
// chargement des fichiers. Toute catégorie absente de cette liste (cas
// résiduel non harmonisé) est ajoutée à la fin, triée alphabétiquement.
const CATEGORY_ORDER = [
  '🤖 IA',
  '📥 Téléchargements',
  '⚙️ Gestion de groupe',
  '🛠️ Outils généraux',
  '🎮 Jeux & Fun',
  '🛡️ Protections',
  '🌸 Anime',
  '🔍 Recherche',
  '👑 Owner',
  '🔧 Configuration',
];
// Affichage fixe (emoji + libellé) de chaque catégorie dans la liste
// numérotée de l'aperçu, quel que soit le style actif : une liste
// numérotée servant à naviguer doit rester lisible et identique.
// (Un système de noms de catégories thématisés par style avait été
// commencé — CAT_NAMES/translateCat — mais n'était jamais appelé nulle
// part et ne couvrait ni les 21 styles ni les 10 catégories ; supprimé
// en Phase 2 pour garder une seule source de vérité.)
const CATEGORY_DISPLAY = {
  '🤖 IA':                    '🤖 IA',
  '📥 Téléchargements':       '📥 Téléchargements',
  '⚙️ Gestion de groupe':     '👥 Gestion de groupe',
  '🛠️ Outils généraux':      '🛠️ Outils généraux',
  '🎮 Jeux & Fun':            '🎮 Jeux & Fun',
  '🛡️ Protections':          '🛡️ Protections',
  '🌸 Anime':                 '🌸 Anime',
  '🔍 Recherche':             '🔎 Recherche',
  '👑 Owner':                 '👑 Owner',
  '🔧 Configuration':         '⚙️ Configuration',
};
function displayCategory(cat) { return CATEGORY_DISPLAY[cat] || cat; }

function sortCategoriesFixed(categoryNames) {
  const known   = CATEGORY_ORDER.filter(c => categoryNames.includes(c));
  const unknown = categoryNames.filter(c => !CATEGORY_ORDER.includes(c)).sort();
  return [...known, ...unknown];
}

const CIRCLED_DIGITS = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩',
  '⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'];
function numberLabel(i) { return CIRCLED_DIGITS[i] || `${i + 1}.`; }

// Suivi des menus envoyés, pour permettre la navigation par réponse.
// Léger et local : pas de timer global, nettoyage opportuniste au fil des
// insertions (même principe que canAutoSticker dans autosticker.js).
const _pendingMenus = new Map(); // messageId -> { style, botName, ownerName, userRank, prefix, categoryNames, categories, senderJid, ts }
const PENDING_MENU_TTL_MS   = 15 * 60 * 1000; // 15 min : au-delà, un menu affiché est jugé périmé
const PENDING_MENU_SWEEP_AT = 300;             // balayage seulement si la Map grossit

function trackMenu(messageId, data) {
  if (_pendingMenus.size > PENDING_MENU_SWEEP_AT) {
    const now = Date.now();
    for (const [id, entry] of _pendingMenus) {
      if (now - entry.ts > PENDING_MENU_TTL_MS) _pendingMenus.delete(id);
    }
  }
  _pendingMenus.set(sessionContext.scopeKey(messageId), { ...data, ts: Date.now() });
}

// Aperçu : en-tête habituel (avec style/titre/image personnalisés) + liste
// numérotée des catégories, chacune avec son nombre de commandes.
function buildCategoryOverview(style, botName, ownerName, userRank, prefix, categoryNames, categories, count, senderJid) {
  const s = STYLES[style] || STYLES[1];
  let text = buildImmersiveHeader(style, senderJid, count, botName);
  text += s.header(botName, ownerName, userRank, prefix, count);
  categoryNames.forEach((cat, i) => {
    const n = (categories[cat] || []).length;
    text += `${numberLabel(i)} ${displayCategory(cat)} (${n})\n`;
  });
  text += `\n💬 *Répondez à ce message avec le numéro de la catégorie que vous souhaitez ouvrir.*\n`;
  text += s.footer();
  text += SIGNATURE;
  return text;
}

// Détail d'une catégorie — affichage épuré et uniforme (indépendant du
// style visuel), conforme au format demandé : cadre simple, liste à puces,
// total, puis retour possible avec "0".
const COMMANDS_PER_PAGE = 20; // pagination : au-delà, une catégorie est découpée en pages

// Détail d'une catégorie — affichage épuré et uniforme (indépendant du
// style visuel). Pagination automatique au-delà de COMMANDS_PER_PAGE.
function buildCategoryDetail(catName, cmds, page = 1) {
  const sorted     = cmds.slice().sort((a,b) => a.name.localeCompare(b.name));
  const totalPages = Math.max(1, Math.ceil(sorted.length / COMMANDS_PER_PAGE));
  const p          = Math.min(Math.max(1, page), totalPages);
  const pageItems  = sorted.slice((p - 1) * COMMANDS_PER_PAGE, p * COMMANDS_PER_PAGE);

  const pageLabel = totalPages > 1 ? ` (Page ${p}/${totalPages})` : '';
  let text = `╭── ${displayCategory(catName)}${pageLabel} ──\n\n`;
  pageItems.forEach(cmd => { text += `• ${cmd.name}\n`; });
  text += `\nTotal : ${sorted.length} commandes\n\n`;
  if (totalPages > 1) {
    text += `➡️ Répondez *suivant* ou *page ${p < totalPages ? p + 1 : 1}* pour changer de page.\n`;
  }
  text += `🔎 Répondez avec le *nom d'une commande* pour voir sa fiche.\n`;
  text += `0️⃣ Répondez avec *0* pour revenir au menu principal.\n`;
  text += SIGNATURE;
  return text;
}

// ══════════════════════════════════════════════════════════════
// 🔎 MOTEUR DE RECHERCHE & CORRECTION FLOUE (fuzzy matching)
// ══════════════════════════════════════════════════════════════
// Utilisé à la fois par la recherche du menu (sections ci-dessous) ET par
// handler.js pour corriger automatiquement les fautes de frappe sur
// N'IMPORTE QUELLE commande du bot (pas seulement depuis le menu) — voir
// l'export `fuzzyMatchCommand` en bas de ce fichier.
//
// Architecture : un seul index, construit une fois et mis en cache
// (voir getCommandIndex), réutilisé par toutes les fonctions de recherche
// ci-dessous. Reconstruit uniquement si loadCommands() change de
// référence (c'est-à-dire après un .reload) — jamais recalculé à chaque
// message, pour rester performant.

let _commandIndex = null;      // Array<{ name, aliases, description, usage, category, cmd }>
let _indexedCommandsRef = null; // référence du Map source utilisée pour construire l'index

function getCommandIndex() {
  const commandsMap = loadCommands();
  if (_commandIndex && _indexedCommandsRef === commandsMap) return _commandIndex;

  // (Re)construction : dédoublonnée par objet commande (la Map contient
  // une entrée par alias en plus du nom, qui pointent vers le MÊME objet).
  const seen = new Set();
  const index = [];
  for (const cmd of commandsMap.values()) {
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    index.push({
      name: cmd.name,
      aliases: cmd.aliases || [],
      description: (cmd.description || '').toLowerCase(),
      usage: (cmd.usage || '').toLowerCase(),
      category: cmd.category || '',
      cmd,
    });
  }
  _commandIndex = index;
  _indexedCommandsRef = commandsMap;
  return index;
}

/**
 * Distance de Levenshtein classique (nombre minimal d'insertions/
 * suppressions/substitutions pour passer de a à b). Implémentation
 * itérative à deux lignes — légère, O(n*m) en temps, O(min(n,m)) en
 * mémoire, largement suffisante pour des noms de commandes courts.
 */
/**
 * Distance de Damerau-Levenshtein (variante "optimal string alignment") :
 * comme Levenshtein classique (insertion/suppression/substitution), mais
 * compte aussi la transposition de deux lettres adjacentes comme une
 * SEULE opération plutôt que deux substitutions. C'est le type de faute
 * de frappe le plus courant sur clavier mobile (ex: "ytpm3" au lieu de
 * "ytmp3") — sans cette variante, ces fautes très communes ne seraient
 * jamais assez proches pour une correction automatique fiable.
 * Toujours O(n*m) en temps, aussi légère que Levenshtein classique.
 */
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,      // suppression
        d[i][j - 1] + 1,      // insertion
        d[i - 1][j - 1] + cost // substitution
      );
      // Transposition de deux lettres adjacentes (ex: "tp" <-> "pt")
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** Score de similarité normalisé entre 0 (rien en commun) et 1 (identique). */
function similarityScore(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

// Seuils de confiance pour la correction — calibrés pour ÉVITER TOUTE
// EXÉCUTION AUTOMATIQUE SANS CONFIRMATION (règle de sécurité demandée) :
//   - CONFIRM_MIN   : score minimal (>95%) pour proposer UNE correction
//                     avec demande de confirmation explicite ("oui")
//   - SUGGEST_MIN   : score minimal pour apparaître dans une liste de
//                     suggestions ("vouliez-vous dire")
// Dans TOUS les cas, aucune commande n'est jamais exécutée directement
// par ce moteur — il propose seulement, l'exécution reste soumise à
// confirmation explicite de l'utilisateur (voir handleMenuNavigationReply
// et handleUnknownCommand, qui gèrent la confirmation "oui").
const CONFIRM_MIN     = 0.95;
const SUGGEST_MIN     = 0.45;
const MAX_SUGGESTIONS = 5;

/**
 * Recherche large (point 3/4 du cahier des charges) : cherche `query`
 * en sous-chaîne dans le nom, les alias, la description et l'utilisation
 * de chaque commande. Ne fait AUCUNE approximation floue ici (c'est le
 * rôle de fuzzyMatchCommand) — uniquement une recherche par mot-clé.
 * Retourne un tableau de commandes (dédoublonnées), sans limite de score.
 */
function searchCommandsBroad(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return getCommandIndex()
    .filter(entry =>
      entry.name.toLowerCase().includes(q) ||
      entry.aliases.some(a => String(a).toLowerCase().includes(q)) ||
      entry.description.includes(q) ||
      entry.usage.includes(q)
    )
    .map(entry => entry.cmd);
}

/**
 * Correction floue d'un nom de commande potentiellement mal orthographié.
 * Suit exactement l'ordre de règles demandé :
 *   1. nom exact
 *   2. alias exact
 *   3. similarité (Damerau-Levenshtein normalisée)
 * Retourne { exact, confirmCandidate, suggestions } :
 *   - exact            : la commande si le nom/alias tapé existe tel quel
 *   - confirmCandidate : UNE commande si un unique candidat dépasse 95%
 *                        de similarité (à proposer avec confirmation
 *                        "oui" — jamais exécutée directement, voir plus
 *                        haut)
 *   - suggestions      : liste de candidats proches mais ambigus (2+
 *                        candidats en haute confiance, ou confiance
 *                        moyenne) — à proposer sous forme de liste
 */
function fuzzyMatchCommand(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { exact: null, confirmCandidate: null, suggestions: [] };

  const index = getCommandIndex();

  // 1. Nom exact — 2. Alias exact
  for (const entry of index) {
    if (entry.name.toLowerCase() === q) return { exact: entry.cmd, confirmCandidate: null, suggestions: [] };
  }
  for (const entry of index) {
    if (entry.aliases.some(a => String(a).toLowerCase() === q)) {
      return { exact: entry.cmd, confirmCandidate: null, suggestions: [] };
    }
  }

  // 3. Similarité — meilleur score par commande (sur son nom ET ses alias)
  const scored = index.map(entry => {
    const candidates = [entry.name, ...entry.aliases.map(String)];
    const best = Math.max(...candidates.map(c => similarityScore(q, c.toLowerCase())));
    return { cmd: entry.cmd, score: best };
  })
  .filter(r => r.score >= SUGGEST_MIN)
  .sort((a, b) => b.score - a.score);

  if (!scored.length) return { exact: null, confirmCandidate: null, suggestions: [] };

  // Un seul candidat en très haute confiance (>95%) et sans ambiguïté
  // (aucun autre candidat n'atteint aussi ce seuil) → confirmation simple.
  const highConfidence = scored.filter(r => r.score >= CONFIRM_MIN);
  if (highConfidence.length === 1) {
    return { exact: null, confirmCandidate: highConfidence[0].cmd, suggestions: [] };
  }

  // Sinon (aucun candidat très confiant, ou plusieurs ex-aequo) → liste
  return { exact: null, confirmCandidate: null, suggestions: scored.slice(0, MAX_SUGGESTIONS).map(r => r.cmd) };
}

// Affichage d'une liste de résultats de recherche ou de suggestions,
// numérotée pour permettre une sélection par réponse.
function buildResultsList(title, cmds) {
  let text = `╭── ${title} ──\n\n`;
  cmds.forEach((cmd, i) => { text += `${i + 1}. ${cmd.name}\n`; });
  text += `\n💬 Répondez avec le numéro pour voir la fiche.\n`;
  text += `0️⃣ Répondez avec *0* pour revenir au menu principal.\n`;
  text += SIGNATURE;
  return text;
}

// Message de confirmation avant exécution d'une commande corrigée
// (correction floue à très haute confiance, >95%, un seul candidat).
// Le bot ne l'exécute JAMAIS de lui-même — uniquement après un "oui"
// explicite de l'utilisateur (voir handleMenuNavigationReply).
function buildConfirmPrompt(cmd) {
  let text = `❓ *Commande inconnue.*\n\n`;
  text += `✅ *Correction proposée :*\n${cmd.name}\n\n`;
  text += `Répondez par *oui* pour exécuter cette commande, ou ignorez ce message.\n`;
  text += SIGNATURE;
  return text;
}

// Fiche détaillée d'une commande — trouvée par recherche exacte (nom ou alias).
function buildCommandCard(cmd, prefix) {
  let text = `╭── Commande : ${cmd.name} ──\n\n`;
  text += `📝 *Description :*\n${cmd.description || '_Aucune description._'}\n\n`;
  text += `🔗 *Alias :*\n${(cmd.aliases && cmd.aliases.length) ? cmd.aliases.join(', ') : '_Aucun_'}\n\n`;
  text += `📂 *Catégorie :*\n${cmd.category || '_Non classée_'}\n\n`;
  text += `⚙️ *Utilisation :*\n${cmd.usage || `${prefix}${cmd.name}`}\n\n`;
  const perms = [];
  if (cmd.groupOnly)      perms.push('groupe uniquement');
  if (cmd.adminOnly)      perms.push('admin uniquement');
  if (cmd.botAdminNeeded) perms.push('bot admin requis');
  text += `🔐 *Permissions :*\n${perms.length ? perms.join(', ') : 'aucune restriction particulière'}\n\n`;
  text += `0️⃣ Répondez avec *0* pour revenir au menu principal.\n`;
  text += SIGNATURE;
  return text;
}

/**
 * Gère une réponse (quote) à un message de menu déjà envoyé.
 * Appelée depuis handler.js. Retourne true si le message a été traité,
 * false sinon — dans ce cas handler.js doit continuer son traitement
 * normal du message.
 *
 * Reconnaît, en réponse à N'IMPORTE QUEL message de menu déjà suivi
 * (aperçu, détail de catégorie ou fiche de commande) :
 *  - "0"                → retour au menu principal
 *  - un numéro 1..N      → ouvre directement cette catégorie (sans devoir
 *                          repasser par 0, y compris depuis un détail)
 *  - "suivant"/"page N"  → navigation de pages dans la catégorie affichée
 *  - un nom de commande  → ouvre la fiche de cette commande
 */
/**
 * Gère une réponse (quote) à un message de menu déjà envoyé.
 * Appelée depuis handler.js. Retourne toujours un objet :
 *   { handled: boolean, reExecute: {commandName, args, originalMsg} | null }
 *
 *   - handled=false                → rien reconnu, handler.js continue
 *     son traitement normal du message.
 *   - handled=true, reExecute=null → une réponse a été envoyée (aperçu,
 *     catégorie, fiche, liste...), rien de plus à faire côté handler.js.
 *   - handled=true, reExecute={..} → l'utilisateur a confirmé ("oui")
 *     l'exécution d'une commande précédemment corrigée. handler.js DOIT
 *     alors relancer le message corrigé via le pipeline normal complet
 *     (handleMessage), pour que TOUTES les vérifications de permissions
 *     s'appliquent exactement comme pour un message tapé normalement.
 *     Ce module ne exécute JAMAIS de commande lui-même — voir la note de
 *     sécurité dans le bloc "oui" ci-dessous.
 *
 * Reconnaît, en réponse à N'IMPORTE QUEL message de menu déjà suivi :
 *  - "oui"               → confirme l'exécution d'une correction proposée
 *  - "0"                  → retour au menu principal
 *  - un numéro 1..N       → ouvre directement cette catégorie (ou, si la
 *                           dernière vue était une liste de résultats,
 *                           sélectionne un résultat de cette liste)
 *  - "suivant"/"page N"   → navigation de pages dans la catégorie affichée
 *  - un nom de commande   → ouvre la fiche de cette commande
 *  - texte libre          → recherche large, puis correction floue
 */
async function handleMenuNavigationReply(sock, msg, extra) {
  const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
  if (!stanzaId || !_pendingMenus.has(sessionContext.scopeKey(stanzaId))) return { handled: false, reExecute: null };

  const rawBody = (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text || ''
  ).trim();
  if (!rawBody) return { handled: false, reExecute: null };

  const entry = _pendingMenus.get(sessionContext.scopeKey(stanzaId));

  const sendAndTrack = async (text, extraData = {}) => {
    const sentMsg = await sock.sendMessage(extra.from, { text }, { quoted: msg });
    if (sentMsg?.key?.id) trackMenu(sentMsg.key.id, { ...entry, ...extraData });
    return sentMsg;
  };

  // ── "oui" → confirme l'exécution d'une correction proposée ───────────
  // ⚠️ SÉCURITÉ : ce module ne fait JAMAIS l'exécution lui-même (il n'a
  // pas accès aux vérifications de permissions/cooldowns/hiérarchie
  // d'accès de handler.js, et les dupliquer ici serait risqué et source
  // de désynchronisation). Il se contente de retourner les informations
  // nécessaires ; c'est handler.js qui réinjecte le message corrigé dans
  // le pipeline normal (handleMessage), qui applique alors EXACTEMENT
  // les mêmes contrôles que si l'utilisateur avait tapé la commande
  // correctement lui-même.
  if (entry.mode === 'confirm' && /^(oui|yes|o|y)$/i.test(rawBody)) {
    if (!entry.pendingCommandName || !entry.originalMsg) {
      return { handled: false, reExecute: null }; // entrée corrompue/incomplète, ignorer
    }
    return {
      handled: true,
      reExecute: {
        commandName: entry.pendingCommandName,
        args: entry.pendingArgs || [],
        originalMsg: entry.originalMsg,
      },
    };
  }

  // ── "0" → retour au menu principal ──────────────────────────────────
  if (rawBody === '0') {
    const overviewText = buildCategoryOverview(
      entry.style, entry.botName, entry.ownerName, entry.userRank,
      entry.prefix, entry.categoryNames, entry.categories, entry.count, entry.senderJid
    );
    await sendAndTrack(overviewText, { currentCategory: null, currentPage: 1, mode: 'overview', resultList: null });
    return { handled: true, reExecute: null };
  }

  // ── Sélection dans une liste de résultats/suggestions déjà affichée ──
  // Prioritaire sur "numéro = catégorie" : si le dernier message affiché
  // était une liste de résultats de recherche, un numéro désigne un
  // résultat de CETTE liste, pas une catégorie.
  if (entry.mode === 'results' && Array.isArray(entry.resultList) && /^\d+$/.test(rawBody)) {
    const idx = parseInt(rawBody, 10) - 1;
    if (idx < 0 || idx >= entry.resultList.length) {
      await extra.reply(`*⚠️ Numéro invalide. Choisis entre 1 et ${entry.resultList.length} (ou 0 pour le menu).*`);
      return { handled: true, reExecute: null };
    }
    const text = buildCommandCard(entry.resultList[idx], entry.prefix);
    await sendAndTrack(text, { mode: 'card', resultList: null });
    return { handled: true, reExecute: null };
  }

  // ── Numéro de catégorie → ouvre directement cette catégorie ──────────
  if (/^\d+$/.test(rawBody)) {
    const idx = parseInt(rawBody, 10) - 1;
    if (idx < 0 || idx >= entry.categoryNames.length) {
      await extra.reply(`*⚠️ Numéro invalide. Choisis entre 0 et ${entry.categoryNames.length}.*`);
      return { handled: true, reExecute: null };
    }
    const catName = entry.categoryNames[idx];
    const cmds    = entry.categories[catName] || [];
    const text    = buildCategoryDetail(catName, cmds, 1);
    await sendAndTrack(text, { currentCategory: catName, currentPage: 1, mode: 'category', resultList: null });
    return { handled: true, reExecute: null };
  }

  // ── Pagination : "suivant" / "précédent" / "page N" ──────────────────
  // Uniquement pertinent si on est actuellement sur une vue de catégorie.
  if (entry.currentCategory) {
    const lower = rawBody.toLowerCase();
    const cmds  = entry.categories[entry.currentCategory] || [];
    const totalPages = Math.max(1, Math.ceil(cmds.length / COMMANDS_PER_PAGE));
    let targetPage = null;

    if (lower === 'suivant' || lower === 'next') {
      targetPage = Math.min((entry.currentPage || 1) + 1, totalPages);
    } else if (lower === 'précédent' || lower === 'precedent' || lower === 'prev') {
      targetPage = Math.max((entry.currentPage || 1) - 1, 1);
    } else {
      const pageMatch = lower.match(/^page\s+(\d+)$/);
      if (pageMatch) targetPage = parseInt(pageMatch[1], 10);
    }

    if (targetPage !== null) {
      const text = buildCategoryDetail(entry.currentCategory, cmds, targetPage);
      await sendAndTrack(text, { currentPage: Math.min(Math.max(1, targetPage), totalPages) });
      return { handled: true, reExecute: null };
    }
  }

  // ── Recherche intelligente : nom/alias exact, puis description/
  // utilisation, puis correction floue en dernier recours ────────────
  // 1. Correspondance exacte (nom ou alias) → fiche directe
  const exactMatch = getCommandIndex().find(e =>
    e.name.toLowerCase() === rawBody.toLowerCase() ||
    e.aliases.some(a => String(a).toLowerCase() === rawBody.toLowerCase())
  );
  if (exactMatch) {
    await sendAndTrack(buildCommandCard(exactMatch.cmd, entry.prefix), { mode: 'card', resultList: null });
    return { handled: true, reExecute: null };
  }

  // 2. Recherche large (description, utilisation, mots-clés) — plusieurs
  // résultats possibles → liste numérotée, jamais une fiche choisie au hasard
  const broadMatches = searchCommandsBroad(rawBody);
  if (broadMatches.length === 1) {
    await sendAndTrack(buildCommandCard(broadMatches[0], entry.prefix), { mode: 'card', resultList: null });
    return { handled: true, reExecute: null };
  }
  if (broadMatches.length > 1) {
    const limited = broadMatches.slice(0, 15); // liste raisonnable, pas un déversement complet
    const text = buildResultsList(`Résultats pour "${rawBody}"`, limited);
    await sendAndTrack(text, { mode: 'results', resultList: limited });
    return { handled: true, reExecute: null };
  }

  // 3. Rien trouvé par mot-clé → tentative de correction floue (fautes de
  // frappe). Ici aussi : jamais d'exécution directe, uniquement une
  // fiche (consultative) ou une liste — cette section reste à l'intérieur
  // du menu, où rien n'est jamais exécuté automatiquement.
  const fuzzy = fuzzyMatchCommand(rawBody);
  if (fuzzy.confirmCandidate) {
    await sendAndTrack(buildCommandCard(fuzzy.confirmCandidate, entry.prefix), { mode: 'card', resultList: null });
    return { handled: true, reExecute: null };
  }
  if (fuzzy.suggestions.length) {
    const text = buildResultsList(`Vouliez-vous dire`, fuzzy.suggestions);
    await sendAndTrack(text, { mode: 'results', resultList: fuzzy.suggestions });
    return { handled: true, reExecute: null };
  }

  return { handled: false, reExecute: null }; // rien de reconnu → on laisse passer normalement
}

// Construit le contexte complet du menu pour un utilisateur donné
// (catégories groupées, style actif, identité affichée...). Facteur commun
// entre `execute()` (affichage normal du menu) et la correction globale de
// commandes (handler.js) — une seule source de vérité, pas d'architecture
// parallèle (voir point 6 du cahier des charges navigation).
function buildMenuContext(rawSender, isSupreme, sock) {
  const commandsMap = loadCommands();
  const categories  = {};
  commandsMap.forEach((cmd, name) => {
    if (cmd.name === name) {
      const cat = cmd.category || '🔮 ᴀᴜᴛʀᴇs';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(cmd);
    }
  });

  const customCfg = getCustomMenuConfig(rawSender) || {};
  const count     = Object.values(categories).reduce((a,c) => a+c.length, 0);
  const botName   = customCfg.title || config.botName || '𝐓𝐇𝐄 𝐁𝐈𝐆 𝐃𝐈𝐏𝐏𝐄𝐑';
  // [Phase 3 — chantier Pairing/identité] Nom du compte WhatsApp RÉELLEMENT
  // connecté sur CETTE session (sock passé par l'appelant, jamais une
  // référence globale — isolation multi-session préservée). .env OWNER_NAME
  // n'est plus utilisé qu'en tout dernier recours (fallback), si le nom du
  // compte n'est pas encore disponible.
  const envOwnerNameFallback = Array.isArray(config.ownerName) ? config.ownerName.join(', ') : (config.ownerName || 'Trésor');
  const ownerName = getConnectedOwnerName(sock, envOwnerNameFallback);
  const userRank  = isSupreme ? toSmallCaps('♛ maitre supreme') + ' 𓆩⚔︎𓆪' : toSmallCaps('utilisateur');
  // ⚠️ customCfg.style peut valoir 0 (Style DIPPER) : ne pas utiliser
  // `||`, sinon 0 est traité comme absent et on retombe sur le style
  // global au lieu du style personnalisé de l'utilisateur.
  const styleActif    = (customCfg.style !== undefined && customCfg.style !== null)
    ? customCfg.style
    : styleManager.getStyle();
  const categoryNames = sortCategoriesFixed(Object.keys(categories));

  return { categories, categoryNames, count, botName, ownerName, userRank, styleActif, imageUrl: customCfg.imageUrl };
}

module.exports = {
  name: 'grimoire',
  aliases: ['commands','menu','index','m','ɢʀɪᴍᴏɪʀᴇ',
    'style0',
    'style1','style2','style3','style4','style5',
    'style6','style7','style8','style9','style10',
    'style11','style12','style13','style14','style15',
    'style16','style17','style18','style19','style20'],
  category: '🛠️ Outils généraux',
  description: '『 THE BIG DIPPER 』➪ ᴍᴇɴᴜ | .style0 → .style20',
  usage: `.menu | .style0 … .style20`,

  async execute(sock, msg, args, extra) {
    try {
      const rawSender = extra.sender || msg.key.participant || msg.key.remoteJid;
      const isSupreme = SUPREME_JIDS.includes(rawSender) || extra.isOwner || msg.key.fromMe;

      const body = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text || ''
      ).trim().toLowerCase().replace(/^[.\\/!#]/, '');

      const styleMatch = body.match(/^style(\d+)$/);
      if (styleMatch) {
        const num = parseInt(styleMatch[1]);
        if (num < 0 || num > 20) {
          return extra.reply(
            `*⚠️ sᴛʏʟᴇ ɪɴᴠᴀʟɪᴅᴇ !*\n` +
            `ᴄʜᴏɪsɪs ᴇɴᴛʀᴇ \`${prefix}style0\` ᴇᴛ \`${prefix}style20\`\n\n` +
            `> *♰ ᴇ́ᴛᴀʙʟɪ ᴘᴀʀ 𝐃𝐈𝐏𝐏𝐄𝐑 ♰*`
          );
        }
        styleManager.setStyle(num);
        const styleActif = styleManager.getStyle();
        return extra.reply(
          STYLE_CONFIRM[num] +
          `\n\n_ᴛᴀᴘᴇ \`${prefix}menu\` ᴘᴏᴜʀ ᴠᴏɪʀ ʟᴇ ɴᴏᴜᴠᴇᴀᴜ sᴛʏʟᴇ_\n\n> *♰ ᴇ́ᴛᴀʙʟɪ ᴘᴀʀ 𝐃𝐈𝐏𝐏𝐄𝐑 ♰*`
        );
      }

      const { categories, categoryNames, count, botName, ownerName, userRank, styleActif, imageUrl } =
        buildMenuContext(rawSender, isSupreme, sock);
      const menuText = buildCategoryOverview(styleActif, botName, ownerName, userRank, prefix, categoryNames, categories, count, rawSender);

      // Image personnalisée si configurée et valide, sinon image du style
      let imageBuffer = imageUrl ? await getImageBufferFromUrl(imageUrl) : null;
      if (!imageBuffer) imageBuffer = await getImageBufferForStyle(styleActif);

      const messageOptions = {
        mentions: [rawSender],
        contextInfo: {
          forwardingScore: 1,
          isForwarded: true,
          forwardedNewsletterMessageInfo: {
            newsletterJid: config.newsletterJid || '120363411005383995@newsletter',
            newsletterName: config.botName || '𝐓𝐇𝐄 𝐁𝐈𝐆 𝐃𝐈𝐏𝐏𝐄𝐑',
            serverMessageId: -1
          }
        }
      };

      if (imageBuffer) {
        messageOptions.image   = imageBuffer;
        messageOptions.caption = menuText;
      } else {
        messageOptions.text = menuText;
      }

      const sentMsg = await sock.sendMessage(extra.from, messageOptions, { quoted: msg });

      // Mémorise ce menu pour permettre la navigation par réponse
      // (voir handleMenuNavigationReply, branché dans handler.js).
      if (sentMsg?.key?.id) {
        trackMenu(sentMsg.key.id, {
          style: styleActif, botName, ownerName, userRank, prefix,
          categoryNames, categories, count, senderJid: rawSender,
          currentCategory: null, currentPage: 1, mode: 'overview', resultList: null,
        });
      }

    } catch (error) {
      console.error('Menu error:', error);
      await extra.reply(`❌ *ᴇʀʀᴇᴜʀ :* ${error.message}`);
    }
  }
};

module.exports.handleMenuNavigationReply = handleMenuNavigationReply;

// Export pour handler.js — correction automatique des fautes de frappe
// sur N'IMPORTE QUELLE commande tapée dans le bot (pas seulement via le
// menu). Voir le point d'appel dans handler.js, juste après la recherche
// `commands.get(commandName)` qui échoue.
module.exports.fuzzyMatchCommand = fuzzyMatchCommand;

/**
 * Point d'entrée pour handler.js : à appeler quand une commande tapée par
 * l'utilisateur (ex: ".ytpm3") n'existe pas telle quelle.
 *
 * ⚠️ RÈGLE DE SÉCURITÉ : cette fonction n'exécute JAMAIS une commande
 * elle-même, quelle que soit la confiance de la correction. Trois issues
 * possibles, correspondant chacune à un message envoyé à l'utilisateur :
 *
 *   1. Un seul candidat très confiant (>95%, voir CONFIRM_MIN) :
 *      "Commande inconnue. Correction proposée : X. Répondez oui..."
 *      → suivi (mode 'confirm') pour permettre la confirmation, qui sera
 *        traitée par handleMenuNavigationReply puis réinjectée dans le
 *        pipeline normal de handler.js (jamais exécutée directement ici).
 *   2. Plusieurs candidats proches : liste numérotée "vouliez-vous dire".
 *   3. Rien d'assez proche : simple "Commande inconnue." — toujours une
 *      réponse explicite désormais, plus de silence total.
 *
 * @param {string}   typedName  nom de commande tel que tapé (fautif)
 * @param {string[]} typedArgs  arguments tels que tapés, préservés pour
 *                              une éventuelle ré-exécution après confirmation
 * @returns {Promise<{handled: boolean}>} toujours handled=true : dans les
 *   3 cas, une réponse a été envoyée. handler.js n'a rien d'autre à faire
 *   ici (la ré-exécution, si confirmée plus tard, passera par
 *   handleMenuNavigationReply → reExecute, pas par cette fonction).
 */
async function handleUnknownCommand(sock, msg, extra, typedName, typedArgs) {
  const fuzzy = fuzzyMatchCommand(typedName);
  const rawSender = extra.sender || msg.key.participant || msg.key.remoteJid;

  // Cas 1 : un seul candidat très confiant → demande de confirmation
  if (fuzzy.confirmCandidate) {
    const text = buildConfirmPrompt(fuzzy.confirmCandidate);
    const sentMsg = await sock.sendMessage(extra.from, { text }, { quoted: msg });
    if (sentMsg?.key?.id) {
      trackMenu(sentMsg.key.id, {
        mode: 'confirm',
        pendingCommandName: fuzzy.confirmCandidate.name,
        pendingArgs: typedArgs || [],
        originalMsg: msg,
        prefix, senderJid: rawSender,
        // Champs par défaut sûrs (non pertinents dans ce contexte, mais
        // attendus par la forme générale d'une entrée _pendingMenus) :
        categoryNames: [], categories: {}, style: null, botName: null,
        ownerName: null, userRank: null, count: 0,
        currentCategory: null, currentPage: 1, resultList: null,
      });
    }
    return { handled: true };
  }

  // Cas 2 : plusieurs candidats proches → liste de suggestions
  if (fuzzy.suggestions.length) {
    const isSupreme = SUPREME_JIDS.includes(rawSender) || extra.isOwner || msg.key.fromMe;
    const ctx = buildMenuContext(rawSender, isSupreme, sock);

    const text = buildResultsList('Commande inconnue — vouliez-vous dire', fuzzy.suggestions);
    const sentMsg = await sock.sendMessage(extra.from, { text }, { quoted: msg });
    if (sentMsg?.key?.id) {
      trackMenu(sentMsg.key.id, {
        ...ctx, prefix, senderJid: rawSender,
        currentCategory: null, currentPage: 1,
        mode: 'results', resultList: fuzzy.suggestions,
      });
    }
    return { handled: true };
  }

  // Cas 3 : rien d'assez proche → réponse explicite, sans proposition
  await sock.sendMessage(extra.from, { text: `❌ *Commande inconnue.*` }, { quoted: msg });
  return { handled: true };
}
module.exports.handleUnknownCommand = handleUnknownCommand;
