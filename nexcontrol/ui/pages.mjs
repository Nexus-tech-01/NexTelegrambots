import { ObjectId } from 'mongodb';
import { A, X, db, fmtDate, typeLabel } from '../lib/core.mjs';
import { page } from './layout.mjs';

export async function home(){
  const d=await db();
  const [bots,all,publishable,channels,list]=await Promise.all([
    d.collection('bots').countDocuments({enabled:true}),
    d.collection('destinations').countDocuments({active:true}),
    d.collection('destinations').countDocuments({active:true,canPublish:true}),
    d.collection('destinations').countDocuments({active:true,type:'channel'}),
    d.collection('bots').find({enabled:true}).sort({displayName:1}).toArray()
  ]);
  const cards=(await Promise.all(list.map(async(x,i)=>{
    const [total,pub]=await Promise.all([
      d.collection('destinations').countDocuments({botId:x._id,active:true}),
      d.collection('destinations').countDocuments({botId:x._id,active:true,canPublish:true})
    ]);
    const on=x.lastHeartbeatAt&&Date.now()-new Date(x.lastHeartbeatAt).getTime()<180000;
    return `<a class="bot-card fade-up" href="/destinations?botId=${x._id}"><div class="bot-index">${String(i+1).padStart(2,'0')} / ${String(list.length).padStart(2,'0')}</div><div class="bot-name">${X(x.displayName||x.slug)}</div><div class="bot-meta"><span><i class="dot ${on?'on':''}"></i>${on?'Online':'Silencieux'}</span><span>${total} destinations · ${pub} publiables</span></div></a>`;
  }))).join('');
  return page('Control',`<section class="hero"><div><div class="eyebrow">Nexus operations layer</div><h1 class="display">Control<br><span class="soft">the whole</span><br>network.</h1><p class="lead">Un seul espace pour surveiller les bots, comprendre exactement où ils peuvent publier et orchestrer les messages de tout l'écosystème Nex.</p></div><div class="hero-foot"><p class="micro">Synchronisation des permissions Telegram · campagnes programmées · état de la flotte · contrôle centralisé.</p><a class="scroll-mark" href="#fleet">↓</a></div></section><section class="stats fade-up"><div class="stat"><span class="stat-label">Bots actifs</span><strong class="stat-num">${bots}</strong></div><div class="stat"><span class="stat-label">Destinations</span><strong class="stat-num">${all}</strong></div><div class="stat"><span class="stat-label">Publiables</span><strong class="stat-num">${publishable}</strong></div><div class="stat"><span class="stat-label">Chaînes</span><strong class="stat-num">${channels}</strong></div></section><section class="section" id="fleet"><div class="section-head fade-up"><div><div class="section-kicker">01 — Fleet</div><h2 class="section-title">Every bot.<br>One surface.</h2></div><p class="section-note">Glisse horizontalement pour parcourir la flotte. Chaque carte t'emmène directement vers les groupes et chaînes que le bot connaît.</p></div><div class="rail">${cards||'<div class="empty">Aucun bot enregistré pour le moment.</div>'}</div></section>`,'home');
}

export async function bots(){
  const d=await db(),list=await d.collection('bots').find({}).sort({displayName:1}).toArray();
  const cards=(await Promise.all(list.map(async(x,i)=>{
    const [total,pub,chan]=await Promise.all([
      d.collection('destinations').countDocuments({botId:x._id,active:true}),
      d.collection('destinations').countDocuments({botId:x._id,active:true,canPublish:true}),
      d.collection('destinations').countDocuments({botId:x._id,active:true,type:'channel'})
    ]);
    const on=x.lastHeartbeatAt&&Date.now()-new Date(x.lastHeartbeatAt).getTime()<180000;
    return `<a class="bot-card fade-up" href="/destinations?botId=${x._id}"><div class="bot-index">${String(i+1).padStart(2,'0')} · ${X(x.slug)}</div><div class="bot-name">${X(x.displayName||x.slug)}</div><div class="bot-meta"><span><i class="dot ${on?'on':''}"></i>${on?'Online':'Silencieux'}${x.version?' · v'+X(x.version):''}</span><span>${total} total · ${pub} OK · ${chan} chaînes</span></div></a>`;
  }))).join('');
  return page('Bots',`<div class="page-head"><div><div class="eyebrow">Fleet registry</div><h1 class="page-title">Bots</h1></div><p class="page-sub">Chaque bot possède sa propre identité API et remonte son heartbeat, sa version et ses destinations connues.</p></div><section class="section"><div class="rail">${cards||'<div class="empty">Aucun bot enregistré.</div>'}</div></section><section class="section fade-up"><div class="section-head"><div><div class="section-kicker">Register</div><h2 class="section-title">Add a bot.</h2></div><p class="section-note">La clé API n'est affichée qu'une fois. Elle doit rester côté serveur du bot.</p></div><div class="panel"><form id="botForm" class="filters"><input name="slug" placeholder="nexgroup" required><input name="displayName" placeholder="NexGroup Manager" required><input name="username" placeholder="@username"><button class="action primary">Créer le bot</button></form><div id="botOut" class="result"></div></div></section><script>botForm.onsubmit=async e=>{e.preventDefault();let x=Object.fromEntries(new FormData(botForm)),r=await fetch('/api/admin/bots',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(x)}),j=await r.json();botOut.textContent=r.ok?'Clé API — copie-la maintenant : '+j.apiKey:'Erreur : '+(j.error||'inconnue')}</script>`,'bots');
}

export async function destinations(u){
  const d=await db(),bs=await d.collection('bots').find({}).sort({displayName:1}).toArray();
  const names=new Map(bs.map(x=>[String(x._id),x.displayName||x.slug]));
  const filter={active:true},id=u.searchParams.get('botId'),st=u.searchParams.get('publish');
  if(id&&ObjectId.isValid(id))filter.botId=new ObjectId(id);if(st==='yes')filter.canPublish=true;if(st==='no')filter.canPublish=false;
  const list=await d.collection('destinations').find(filter).sort({canPublish:-1,title:1}).limit(1000).toArray();
  const rows=list.map(x=>`<button class="dest-row" type="button" onclick="openDrawer(this)" data-bot="${A(names.get(String(x.botId))||'Bot')}" data-title="${A(x.title)}" data-type="${A(typeLabel(x.type))}" data-chat="${A(x.chatId)}" data-status="${A(x.botStatus||'unknown')}" data-reason="${A(x.canPublish?'Aucun blocage':x.publishBlockReason||'Publication impossible')}" data-verified="${A(fmtDate(x.lastVerifiedAt))}"><div class="hide-xs"><span class="muted">${X(names.get(String(x.botId))||'Bot')}</span></div><div><div class="dest-title">${X(x.title)}</div><div class="dest-id">${X(x.chatId)}${x.username?' · @'+X(x.username):''}</div></div><div class="hide-sm"><span class="pill">${X(typeLabel(x.type))}</span></div><div class="hide-xs">${x.canPublish?'<span class="pill ok">● Can publish</span>':'<span class="pill bad">● Blocked</span><div class="dest-id">'+X(x.publishBlockReason)+'</div>'}</div><div class="arrow">→</div></button>`).join('');
  const opts=bs.map(x=>`<option value="${x._id}"${id===String(x._id)?' selected':''}>${X(x.displayName||x.slug)}</option>`).join('');
  const base={...filter};delete base.canPublish;
  const [yes,no]=await Promise.all([d.collection('destinations').countDocuments({...base,canPublish:true}),d.collection('destinations').countDocuments({...base,canPublish:false})]);
  return page('Destinations',`<div class="page-head"><div><div class="eyebrow">Publish permissions</div><h1 class="page-title">Destinations</h1></div><p class="page-sub">Tous les groupes, supergroupes et chaînes connus. Un statut bloqué reste visible avec sa raison exacte au lieu d'être masqué.</p></div><div class="stats fade-up"><div class="stat"><span class="stat-label">Résultats</span><strong class="stat-num">${list.length}</strong></div><div class="stat"><span class="stat-label">Can publish</span><strong class="stat-num">${yes}</strong></div><div class="stat"><span class="stat-label">Blocked</span><strong class="stat-num">${no}</strong></div><div class="stat"><span class="stat-label">Filtre bot</span><strong class="stat-num" style="font-size:22px;line-height:1">${id?X(names.get(id)||'1 bot'):'ALL'}</strong></div></div><form class="filters"><select name="botId"><option value="">Tous les bots</option>${opts}</select><select name="publish"><option value="">Tous les statuts</option><option value="yes"${st==='yes'?' selected':''}>Publication possible</option><option value="no"${st==='no'?' selected':''}>Publication impossible</option></select><button class="action primary">Appliquer</button><a class="action" href="/destinations">Réinitialiser</a></form><div class="dest-list fade-up">${rows||'<div class="empty">Aucune destination ne correspond à ce filtre.</div>'}</div><aside class="drawer"><button class="drawer-close" onclick="closeDrawer()">×</button><div class="drawer-kicker">Destination detail</div><h2 data-field="title">Destination</h2><dl><div><dt>Bot</dt><dd data-field="bot"></dd></div><div><dt>Type</dt><dd data-field="type"></dd></div><div><dt>Chat ID</dt><dd data-field="chat"></dd></div><div><dt>Statut Telegram</dt><dd data-field="status"></dd></div><div><dt>Publication</dt><dd data-field="reason"></dd></div><div><dt>Dernière vérification</dt><dd data-field="verified"></dd></div></dl><button class="send" onclick="location.href='/campaigns/new'">Créer une publication</button></aside>`,'destinations');
}

export async function campaigns(){
  const d=await db(),list=await d.collection('campaigns').find({}).sort({createdAt:-1}).limit(100).toArray();let rows='';
  for(const x of list){
    const [sent,fail,pending]=await Promise.all([
      d.collection('deliveries').countDocuments({campaignId:x._id,status:'sent'}),
      d.collection('deliveries').countDocuments({campaignId:x._id,status:'failed'}),
      d.collection('deliveries').countDocuments({campaignId:x._id,status:{$in:['pending','claimed']}})
    ]);
    rows+=`<tr><td><strong>${X(x.title)}</strong><div class="dest-id">${X(fmtDate(x.createdAt))}</div></td><td><span class="pill">${X(x.status)}</span></td><td>${sent}</td><td>${pending}</td><td>${fail}</td></tr>`;
  }
  return page('Campagnes',`<div class="page-head"><div><div class="eyebrow">Broadcast history</div><h1 class="page-title">Campagnes</h1></div><div><p class="page-sub">Historique central de tes publications, avec statut d'exécution et résultats par destination.</p><a class="action primary" href="/campaigns/new" style="margin-top:16px">Nouvelle publication</a></div></div><section class="section fade-up"><div class="panel"><table class="table"><thead><tr><th>Campagne</th><th>État</th><th>Envoyés</th><th>En attente</th><th>Échecs</th></tr></thead><tbody>${rows||'<tr><td colspan="5" class="muted">Aucune campagne.</td></tr>'}</tbody></table></div></section>`,'campaigns');
}

export async function compose(){
  const d=await db(),bs=await d.collection('bots').find({enabled:true}).sort({displayName:1}).toArray();
  const botChoices=bs.map(x=>`<label class="check"><input type="checkbox" name="bot" value="${x._id}"><span>${X(x.displayName||x.slug)}</span></label>`).join('');
  return page('Publier',`<div class="page-head"><div><div class="eyebrow">Broadcast studio</div><h1 class="page-title">Publish</h1></div><p class="page-sub">Compose le message, choisis les bots et les types de destinations, puis publie immédiatement ou programme l'envoi.</p></div><div class="compose"><div class="studio fade-up"><form id="campaignForm"><label>Nom interne</label><input type="text" name="title" value="Annonce NexControl"><label>Message</label><textarea name="text" id="msg" placeholder="Écris ton message..."></textarea><label>Image / média</label><input type="url" name="mediaUrl" id="mediaUrl" placeholder="https://..."><label>Bots</label><div class="checks">${botChoices||'<span class="muted">Aucun bot actif.</span>'}</div><label>Destinations</label><div class="checks"><label class="check"><input type="checkbox" name="type" value="group" checked><span>Groupes</span></label><label class="check"><input type="checkbox" name="type" value="supergroup" checked><span>Supergroupes</span></label><label class="check"><input type="checkbox" name="type" value="channel" checked><span>Chaînes</span></label></div><label>Programmation</label><input type="datetime-local" name="scheduledAt"><div style="display:flex;gap:10px;margin-top:28px"><button class="action primary" style="flex:1">Programmer / envoyer</button></div><div id="campaignOut" class="result"></div></form></div><aside class="preview fade-up"><div class="preview-kicker">Live Telegram preview</div><div class="phone"><div class="tg-bubble"><div class="tg-media" id="previewMedia"></div><div class="tg-text" id="previewText">Ton message apparaîtra ici.</div></div></div></aside></div><script>const syncPreview=()=>{previewText.textContent=msg.value||'Ton message apparaîtra ici.';previewMedia.style.display=mediaUrl.value?'block':'none'};msg.oninput=syncPreview;mediaUrl.oninput=syncPreview;campaignForm.onsubmit=async e=>{e.preventDefault();let g=n=>[...campaignForm.querySelectorAll('[name='+n+']:checked')].map(x=>x.value),x={title:campaignForm.title.value,text:campaignForm.text.value,mediaUrl:campaignForm.mediaUrl.value,botIds:g('bot'),types:g('type'),scheduledAt:campaignForm.scheduledAt.value||undefined},r=await fetch('/api/admin/campaigns',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(x)}),j=await r.json();campaignOut.textContent=r.ok?j.deliveries+' envoi(s) préparé(s).':'Erreur : '+(j.error||'inconnue')}</script>`,'compose');
}
