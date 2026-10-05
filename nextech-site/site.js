const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s));
const app=$("#app"), menu=$("#menu"), drawer=$("#drawer"), shade=$("#shade");
const routes=[
  ["/","Accueil","i-home"],["/about","À propos","i-user"],["/projects","Projets","i-grid"],
  ["/ateliers","Ateliers","i-lab"],["/contact","Contact","i-mail"]
];
const NEXAI_CONNECT="https://nex-telegrambots.vercel.app/";
const icon=id=>'<svg class="icon"><use href="#'+id+'"></use></svg>';
const card=(ico,title,text,reveal)=>'<article class="card" data-r="'+reveal+'"><div class="ibox">'+icon(ico)+'</div><h3>'+title+'</h3><p>'+text+'</p></article>';
const domain=(ico,title,text)=>'<article class="domain" data-r="u"><div class="ibox">'+icon(ico)+'</div><strong>'+title+'</strong><p>'+text+'</p></article>';
const slug=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
const project=(name,tag,desc,meta,cls,image,links=[])=>{
  const media=image?'<div class="project-media"><img src="'+image+'" alt="Photo officielle '+name+'" loading="lazy"></div>':'<div class="project-media project-media-fallback">'+icon("i-spark")+'</div>';
  const actions=links.length?'<div class="project-actions">'+links.map(x=>'<a href="'+x[1]+'" '+(x[2]===false?'':'target="_blank" rel="noreferrer"')+'>'+x[0]+' ↗</a>').join("")+'</div>':'<div class="project-actions"><span class="disabled">Bientôt disponible</span></div>';
  return '<article id="'+slug(name)+'" class="project '+(cls||'')+'" data-r="u">'+media+'<span class="tag">'+tag+'</span><h3>'+name+'</h3><p>'+desc+'</p><div class="meta">'+meta.map(x=>'<span>'+x+'</span>').join("")+'</div>'+actions+'</article>';
};

function currentPath(){
  let p=location.pathname.replace(/\/+$/,"")||"/";
  const valid=routes.some(x=>x[0]===p)||p==="/privacy";
  return valid?p:"/";
}
function renderNav(){
  const p=currentPath();
  $("#nav").innerHTML=routes.map(r=>'<a class="route '+(r[0]===p?"on":"")+'" href="'+r[0]+'">'+r[1]+'</a>').join("")+'<a href="'+NEXAI_CONNECT+'" target="_blank" rel="noreferrer">NexAI Connect</a>';
  $("#drawerNav").innerHTML=routes.map((r,i)=>'<a class="route '+(r[0]===p?"on":"")+'" href="'+r[0]+'">'+icon(r[2])+'<span>'+r[1]+'</span><small>0'+(i+1)+'</small></a>').join("")+'<a href="'+NEXAI_CONNECT+'" target="_blank" rel="noreferrer">'+icon("i-bot")+'<span>NexAI Connect</span><small>↗</small></a>';
}
function setMenu(open){
  drawer.classList.toggle("open",open); shade.classList.toggle("open",open); menu.classList.toggle("open",open);
  drawer.setAttribute("aria-hidden",String(!open)); menu.setAttribute("aria-expanded",String(open));
  document.body.style.overflow=open?"hidden":"";
}
menu.addEventListener("click",()=>setMenu(!drawer.classList.contains("open")));
$("#drawerClose").addEventListener("click",()=>setMenu(false)); shade.addEventListener("click",()=>setMenu(false));

const pages={
"/":()=>'<section class="hero-cover" aria-label="NexTech — Tech, AI, Cyber, Beyond">'+
'<div class="hero-cover__bg" role="img" aria-label="Univers visuel NexTech"></div>'+
'<div class="hero-cover__overlay"></div>'+
'<div class="hero-cover__content shell">'+
'<span class="hero-cover__badge">NEXUS TECH · BENIN → GLOBAL</span>'+
'<h1 class="hero-cover__title"><span>CRÉER, CONNECTER</span><span>ET REPOUSSER</span><span class="gradient">LES LIMITES DE LA TECH.</span></h1>'+
'<p class="hero-cover__text">Cybersécurité, intelligence artificielle, analyse et évaluation de modèles, logiciels et automatisation.</p>'+
'<div class="hero-cover__actions"><a class="btn primary route" href="/projects">Découvrir les projets ↗</a><a class="btn" href="'+NEXAI_CONNECT+'" target="_blank" rel="noreferrer">Connecter NexAI ↗</a></div>'+
'</div></section>'+
'<section class="stats"><div class="stat"><strong>+15</strong><span>PROJETS & SYSTÈMES</span></div><div class="stat"><strong>6</strong><span>ATELIERS</span></div><div class="stat"><strong>100%</strong><span>PASSION TECH</span></div><div class="stat"><strong>∞</strong><span>POSSIBILITÉS</span></div></section>'+
'<section class="section shell"><div class="section-head"><div><div class="kicker">NOTRE ADN</div><h2 data-r="l">Apprendre. Construire. <em>Évoluer ensemble.</em></h2></div><p data-r="r">Nous transformons l’apprentissage en projets concrets. L’objectif n’est pas de collectionner des idées, mais de bâtir des systèmes utiles, robustes et capables de grandir.</p></div>'+
'<div class="cards">'+card("i-shield","Cybersécurité","Défense, analyse, sécurité applicative, automatisation et culture de la résilience.","l")+card("i-ai","IA & Model Analysis","LLM, agents, évaluation de modèles, qualité, sûreté et expérimentation.","r")+card("i-code","Software","Web, mobile, backend, APIs et outils pensés comme de vrais produits.","l")+card("i-network","Automation","Bots, workflows multi-plateformes et systèmes autonomes pilotables.","r")+'</div></section>'+
'<section class="section shell"><div class="section-head"><div><div class="kicker">ÉCOSYSTÈME</div><h2 data-r="l">Des projets qui deviennent <em>des produits.</em></h2></div><p data-r="r">Messagerie, IA, contrôle d’infrastructure, automatisation, média et outils créatifs : chaque projet sert de terrain d’apprentissage et de construction.</p></div>'+
'<div class="projects-grid">'+
project("KnowMe","EN DÉVELOPPEMENT","Projet de messagerie et de réseau social propriétaire actuellement en construction. KnowMe n’est pas encore disponible au public.",["Mobile","Realtime","Coming soon"],"wide tall",null,[["Détails","/projects/knowme",false]])+
project("NexAi","AI & AUTOMATION","Plateforme Telegram multi-session et centre d’automatisation NexTech : comptes connectés, commandes, médias, groupes et services spécialisés.",["Telegram","Multi-session","AI"],"tall","https://nex-telegrambots.vercel.app/api/telegram-avatar?u=NexAi01_bot&v=2",[["Détails","/projects/nexai",false],["Connecter NexAI",NEXAI_CONNECT],["Présentation","https://nex-telegrambots.vercel.app/bots/nexai"]])+
project("NexControl","CONTROL PLANE","Centre de contrôle unifié des VPS, bots, conversations, fichiers, sessions, déploiements et automatisations NexTech.",["DevOps","VPS","Monitoring"],"",null,[["Détails","/projects/nexcontrol",false],["Ouvrir NexControl","https://nexcontrol-render.vercel.app/"]])+
project("NexPlayer","MEDIA PLAYER","Lecteur multimédia Android en développement : bibliothèque, gestes, égaliseur, PIP, thèmes et expérience mobile avancée.",["Android","Media","In development"],"",null,[["Détails","/projects/nexplayer",false]])+
project("NexStick","STICKER ENGINE","Outils Telegram avancés pour créer, convertir, organiser et transformer stickers et packs.",["Stickers","Automation","Bots"],"","https://nex-telegrambots.vercel.app/api/telegram-avatar?u=The_Nexus_techbot&v=2",[["Détails","/projects/nexstick",false],["Voir NexStick","https://nex-telegrambots.vercel.app/bots/nexstick"]])+
'</div></section>'+
'<section class="section tight shell"><div class="actions"><a class="btn primary route" href="/projects">Voir tout l’écosystème ↗</a><a class="btn route" href="/ateliers">Explorer les ateliers</a></div></section>',

"/about":()=>'<section class="page-hero"><div class="shell"><div class="crumb">À PROPOS · NEXUS TECH</div><h1>Une organisation qui veut <span class="gradient">construire pour de vrai.</span></h1><p>Nexus Tech réunit des passionnés autour d’un objectif simple : apprendre des technologies exigeantes, les maîtriser, puis les transformer en produits, systèmes et opportunités.</p></div></section>'+
'<section class="section shell"><div class="mission"><article class="mission-main" data-r="l"><span class="eyebrow">NOTRE MISSION</span><h3>Faire émerger des talents capables de créer, sécuriser et faire évoluer la technologie.</h3><p>Nous voulons développer des compétences solides en cybersécurité, intelligence artificielle, analyse de modèles, logiciel et infrastructure, puis les appliquer à des projets ambitieux conçus depuis l’Afrique pour le monde.</p></article>'+
'<article class="mission-side" data-r="r"><div class="kicker">PRINCIPES</div><div class="principles"><div class="principle"><b>01</b><div><strong>Apprendre en construisant</strong><span>La pratique passe avant les slogans.</span></div></div><div class="principle"><b>02</b><div><strong>Sécurité dès la conception</strong><span>On protège les systèmes avant qu’ils ne deviennent critiques.</span></div></div><div class="principle"><b>03</b><div><strong>Originalité</strong><span>Créer nos propres solutions plutôt que copier sans comprendre.</span></div></div><div class="principle"><b>04</b><div><strong>Ambition mondiale</strong><span>Penser localement, construire pour une échelle globale.</span></div></div></div></article></div></section>'+
'<section class="section shell"><article class="founder" data-r="u"><div class="founder-id"><span class="founder-monogram">TH</span><div><div class="kicker">FONDATEUR</div><h2>Trésor HONTONNOU <em>· Tresor562</em></h2></div></div><div class="founder-copy"><p>NexTech est porté par Trésor HONTONNOU, développeur et créateur orienté cybersécurité, intelligence artificielle, analyse de modèles et construction de produits technologiques. Son portfolio rassemble son parcours, ses travaux et ses projets personnels.</p><div class="actions"><a class="btn primary" href="https://tresor-hontonnou.zone.id/" target="_blank" rel="noreferrer">Voir le portfolio ↗</a><a class="btn" href="https://github.com/Nexus-tech-01" target="_blank" rel="noreferrer">Voir GitHub ↗</a></div></div></article></section><section class="section shell"><div class="section-head"><div><div class="kicker">DOMAINES</div><h2 data-r="l">Nos terrains de <em>construction.</em></h2></div><p data-r="r">Nexus Tech n’est pas limité à une seule technologie. Nous relions plusieurs disciplines pour créer des systèmes plus complets.</p></div><div class="domain-grid">'+domain("i-shield","Cybersecurity","Défense, audit, analyse, sécurité applicative, automatisation et sensibilisation.")+domain("i-ai","Artificial Intelligence","Agents, LLM, RAG, outils intelligents, analyse et évaluation de modèles.")+domain("i-code","Software Engineering","Applications web/mobile, backend, API, architecture et qualité logicielle.")+domain("i-bot","Bots & Automation","Bots Telegram, WhatsApp et Facebook, automatisation de contenus et workflows.")+domain("i-cloud","Cloud & Infrastructure","VPS, CI/CD, observabilité, déploiement et orchestration des services.")+domain("i-spark","Product & Design","UX/UI, branding, prototypage, tests et conception de produits.")+'</div></section>',

"/projects":()=>'<section class="page-hero"><div class="shell"><div class="crumb">PROJETS · ÉCOSYSTÈME</div><h1>Des idées qui prennent <span class="gradient">forme, code et infrastructure.</span></h1><p>Chaque projet répond à un besoin précis. Les produits disponibles sont directement reliés à leur service officiel ; ceux encore en construction sont clairement indiqués.</p></div></section>'+
'<section class="section shell"><div class="projects-grid">'+
project("KnowMe","EN DÉVELOPPEMENT","Messagerie et plateforme sociale propriétaire en cours de développement : comptes, chats, groupes, chaînes, médias, sécurité, bots et fonctions IA. KnowMe n’est pas encore disponible au public.",["Mobile","Realtime","Coming soon"],"wide tall",null,[["Détails","/projects/knowme",false]])+
project("NexAi","AI AUTOMATION","Plateforme Telegram multi-session centrale : connexion de comptes, automatisations, commandes, gestion de groupes, outils médias et services NexTech.",["Telegram","Multi-session","AI"],"tall","https://nex-telegrambots.vercel.app/api/telegram-avatar?u=NexAi01_bot&v=2",[["Détails","/projects/nexai",false],["Connecter NexAI",NEXAI_CONNECT],["Fiche officielle","https://nex-telegrambots.vercel.app/bots/nexai"]])+
project("NexControl","CONTROL PLANE","Supervision des VPS, projets, déploiements, conversations, fichiers, automatisations et sessions depuis une interface centrale.",["DevOps","Monitoring","Control"],"wide",null,[["Détails","/projects/nexcontrol",false],["Ouvrir NexControl","https://nexcontrol-render.vercel.app/"]])+
project("NexPlayer","MEDIA PLAYER","Lecteur Android en développement avec bibliothèque multimédia, égaliseur, thèmes, PIP, gestes et contrôles avancés.",["Android","Media","In development"],"",null,[["Détails","/projects/nexplayer",false]])+
project("NexDownloader","DOWNLOADER","Bot multimédia pour récupérer, préparer, convertir et traiter des contenus depuis plusieurs plateformes.",["Media","Automation","Telegram"],"","https://nex-telegrambots.vercel.app/api/telegram-avatar?u=TheNexDownloader_bot&v=2",[["Détails","/projects/nexdownloader",false],["Voir NexDownloader","https://nex-telegrambots.vercel.app/bots/nexdownloader"]])+
project("NexStick","STICKER ENGINE","Création, conversion, organisation, clonage et transformation avancée de stickers et de packs Telegram.",["Stickers","Bots","Creative"],"","https://nex-telegrambots.vercel.app/api/telegram-avatar?u=The_Nexus_techbot&v=2",[["Détails","/projects/nexstick",false],["Voir NexStick","https://nex-telegrambots.vercel.app/bots/nexstick"]])+
project("Stacy","AI ASSISTANT","Assistante conversationnelle NexTech orientée contexte, échanges naturels, groupes Telegram et interactions sociales.",["Assistant","Telegram","AI"],"","https://nex-telegrambots.vercel.app/api/telegram-avatar?u=Stacytg_bot&v=2",[["Détails","/projects/stacy",false],["Voir Stacy","https://nex-telegrambots.vercel.app/bots/stacy"],["Stacy Play","https://stacy-play.vercel.app/"]])+
project("NexGame","COMMUNITY GAMES","Bot de jeux, quiz et challenges pour rendre les communautés Telegram plus interactives.",["Games","Telegram","Community"],"","https://nex-telegrambots.vercel.app/api/telegram-avatar?u=TheNexGame_bot&v=2",[["Détails","/projects/nexgame",false],["Voir NexGame","https://nex-telegrambots.vercel.app/bots/nexgame"],["Jouer","https://nexus-games-psi.vercel.app/"]])+
'</div></section>',

"/ateliers":()=>'<section class="page-hero"><div class="shell"><div class="crumb">ATELIERS · LEARNING BY BUILDING</div><h1>Choisir un domaine. <span class="gradient">Construire avec une équipe.</span></h1><p>Les ateliers organisent l’apprentissage autour de compétences précises et de projets réels.</p></div></section>'+
'<section class="section shell"><div class="labs">'+
'<article class="lab" data-r="l"><div class="ibox">'+icon("i-code")+'</div><strong>Software Lab</strong><p>Web, mobile, backend, APIs, architecture, tests et qualité logicielle.</p><span class="num">01</span></article>'+
'<article class="lab" data-r="r"><div class="ibox">'+icon("i-ai")+'</div><strong>AI & Model Lab</strong><p>LLM, agents, RAG, fine-tuning, évaluation, red teaming et analyse de modèles.</p><span class="num">02</span></article>'+
'<article class="lab" data-r="l"><div class="ibox">'+icon("i-shield")+'</div><strong>Cybersecurity Lab</strong><p>Sécurité applicative, défense, CTF, analyse, détection et automatisation.</p><span class="num">03</span></article>'+
'<article class="lab" data-r="r"><div class="ibox">'+icon("i-bot")+'</div><strong>Automation Lab</strong><p>Bots, workflows, intégrations, publications et systèmes multi-plateformes.</p><span class="num">04</span></article>'+
'<article class="lab" data-r="l"><div class="ibox">'+icon("i-cloud")+'</div><strong>Cloud & Infrastructure</strong><p>Linux, VPS, CI/CD, monitoring, observabilité et architecture de services.</p><span class="num">05</span></article>'+
'<article class="lab" data-r="r"><div class="ibox">'+icon("i-spark")+'</div><strong>Product & Creative Studio</strong><p>UI/UX, branding, motion, prototypage, produit et expérience utilisateur.</p><span class="num">06</span></article>'+
'</div></section>',

"/contact":()=>'<section class="page-hero"><div class="shell"><div class="crumb">CONTACT · CANAUX OFFICIELS</div><h1>Parlons projet, technologie ou <span class="gradient">collaboration.</span></h1><p>Pour éviter les faux comptes, utilise uniquement les canaux officiels ci-dessous.</p></div></section>'+
'<section class="section shell"><div class="contacts">'+
'<a class="contact" href="https://github.com/Nexus-tech-01" target="_blank" rel="noreferrer" data-r="l"><div class="ibox">'+icon("i-code")+'</div><h3>GitHub</h3><p>Organisation technique, dépôts, code et projets.</p><span class="arrow">↗</span></a>'+
'<a class="contact" href="https://t.me/thenexusorigin" target="_blank" rel="noreferrer" data-r="u"><div class="ibox">'+icon("i-mail")+'</div><h3>Telegram</h3><p>@thenexusorigin — canal officiel Nextech.</p><span class="arrow">↗</span></a>'+
'<a class="contact" href="https://whatsapp.com/channel/0029VbDkWGYHltYHGr1HHQ07" target="_blank" rel="noreferrer" data-r="r"><div class="ibox">'+icon("i-network")+'</div><h3>WhatsApp</h3><p>Canal officiel pour les publications et annonces.</p><span class="arrow">↗</span></a>'+
'</div></section>',

"/privacy":()=>'<section class="page-hero"><div class="shell"><div class="crumb">CONFIDENTIALITÉ</div><h1>Protection des <span class="gradient">informations.</span></h1><p>Nexus Tech limite l’utilisation des informations transmises à ce qui est nécessaire pour traiter une candidature, répondre à un contact ou faire fonctionner ses services.</p></div></section>'+
'<section class="section shell"><div class="mission"><article class="mission-main" data-r="l"><span class="eyebrow">PRINCIPE</span><h3>Collecter moins, protéger mieux.</h3><p>Les données ne doivent pas être conservées sans raison. Les informations de candidature servent uniquement à l’étude du profil et à l’organisation du recrutement.</p></article><article class="mission-side" data-r="r"><div class="kicker">BONNES PRATIQUES</div><div class="principles"><div class="principle"><b>01</b><div><strong>Minimisation</strong><span>Ne demander que ce qui est utile.</span></div></div><div class="principle"><b>02</b><div><strong>Sécurité</strong><span>Limiter les accès et protéger les échanges.</span></div></div><div class="principle"><b>03</b><div><strong>Transparence</strong><span>Expliquer clairement l’usage des informations.</span></div></div></div></article></div></section>'
};

function reveal(){
  const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(reduced){$$("[data-r]").forEach(el=>el.classList.add("in"));return}
  const io=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add("in");io.unobserve(e.target)}}),{threshold:.12,rootMargin:"0px 0px -5%"});
  $$("[data-r]").forEach(el=>io.observe(el));
}
function startNetwork(){
  const c=$("#net"); if(!c||matchMedia("(prefers-reduced-motion: reduce)").matches)return;
  const ctx=c.getContext("2d"); let w=0,h=0,pts=[];
  function resize(){const r=c.getBoundingClientRect();w=r.width;h=r.height;c.width=w*devicePixelRatio;c.height=h*devicePixelRatio;ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);pts=Array.from({length:Math.min(42,Math.max(20,Math.floor(w/34)))},()=>({x:Math.random()*w,y:Math.random()*h,vx:(Math.random()-.5)*.14,vy:(Math.random()-.5)*.12}))}
  function draw(){ctx.clearRect(0,0,w,h);pts.forEach(p=>{p.x+=p.vx;p.y+=p.vy;if(p.x<0||p.x>w)p.vx*=-1;if(p.y<0||p.y>h)p.vy*=-1;ctx.fillStyle="rgba(56,231,255,.5)";ctx.beginPath();ctx.arc(p.x,p.y,1.2,0,Math.PI*2);ctx.fill()});for(let i=0;i<pts.length;i++){for(let j=i+1;j<pts.length;j++){const a=pts[i],b=pts[j],d=Math.hypot(a.x-b.x,a.y-b.y);if(d<120){ctx.strokeStyle="rgba(35,151,255,"+(0.12*(1-d/120))+")";ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke()}}}requestAnimationFrame(draw)}
  resize();draw();addEventListener("resize",resize,{passive:true});
}
function toast(msg){const t=$("#toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),1800)}
function render(path,push){
  path=pages[path]?path:"/";
  if(push)history.pushState({}, "", path);
  app.innerHTML='<div class="page">'+pages[path]()+"</div>";
  document.title=path==="/"?"Nexus Tech — Site officiel":"Nexus Tech — "+(routes.find(r=>r[0]===path)?.[1]||"Confidentialité");
  renderNav();setMenu(false);reveal();startNetwork();window.scrollTo(0,0);
  const emblem=$("#emblem");
  if(emblem&&matchMedia("(hover:hover) and (pointer:fine)").matches&&!matchMedia("(prefers-reduced-motion: reduce)").matches){
    const hero=emblem.closest(".hero");hero.addEventListener("pointermove",e=>{const r=hero.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;emblem.style.transform="perspective(1000px) rotateX("+(-y*4)+"deg) rotateY("+(x*5)+"deg)"});
    hero.addEventListener("pointerleave",()=>emblem.style.transform="");
  }
}
document.addEventListener("click",e=>{const a=e.target.closest("a.route");if(!a)return;const u=new URL(a.href,location.href);if(u.origin!==location.origin)return;e.preventDefault();render(u.pathname,true)});
addEventListener("popstate",()=>render(currentPath(),false));
render(currentPath(),false);