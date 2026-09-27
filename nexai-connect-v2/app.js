import QRCode from 'qrcode';

const API='https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexai-connect';
const $=id=>document.getElementById(id);
let lang='fr',pairId='',pollTimer=null,busy=false,lastQr='';

const t={
fr:{
gateway:'Passerelle sécurisée',eyebrow:'NEXAI · CONNEXION DE COMPTE',
title:'Relie ton compte.<span>Garde le contrôle.</span>',
lead:"Autorise NexAI depuis ton application Telegram. Aucun code de connexion ni mot de passe 2FA n'est saisi sur ce site.",
f1:'Ouvrir Telegram',f2:'Scanner / autoriser',f3:'Session créée',
s1:'Pas de code collecté',s1d:'Le site ne te demande jamais le code reçu par Telegram.',
s2:'Autorisation Telegram',s2d:"La validation se fait depuis une application Telegram déjà connectée.",
s3:'Session côté serveur',s3d:'Après validation, NexAccount stocke uniquement la session nécessaire au fonctionnement.',
cardEyebrow:'SESSION TELEGRAM',cardTitle:'Connecter un compte',
cardSub:'Scanne le QR avec Telegram ou ouvre le lien sur le téléphone déjà connecté.',
readyTitle:'Prêt à créer une session',readySub:'Le QR est temporaire et se renouvelle automatiquement.',
start:'Créer le QR sécurisé',how:'Dans Telegram : Paramètres → Appareils → Lier un appareil, puis scanne le QR.',
scanTitle:'Autorise cette session dans Telegram',scanText:"Le QR expire rapidement. S'il change, scanne simplement le nouveau.",
openTelegram:'Ouvrir dans Telegram',cancel:'Annuler',
extraTitle:'Vérification supplémentaire requise',
extraText:"Telegram exige une étape supplémentaire pour ce compte. Pour ta sécurité, NexAI Connect ne te demandera pas ton mot de passe 2FA sur le web.",
retry:'Recommencer',doneTitle:'Compte connecté',
doneText:'NexAccount a enregistré la session. NexAI peut maintenant fonctionner avec ce compte.',
another:'Connecter un autre compte',footer:"NexAI Connect ne te demandera jamais ton code Telegram ni ton mot de passe 2FA.",
creating:'Création du QR sécurisé…',waiting:'En attente de validation dans Telegram…',
expired:'Le QR a expiré, un nouveau vient d’être généré.',failed:"La connexion n'a pas abouti. Réessaie.",connected:'Connexion réussie.'
},
en:{
gateway:'Secure gateway',eyebrow:'NEXAI · ACCOUNT CONNECTION',
title:'Link your account.<span>Stay in control.</span>',
lead:'Authorize NexAI from your Telegram app. No Telegram login code or 2FA password is entered on this website.',
f1:'Open Telegram',f2:'Scan / approve',f3:'Session created',
s1:'No code collected',s1d:'The website never asks for the login code Telegram sends you.',
s2:'Telegram approval',s2d:'Authorization happens inside an already signed-in Telegram app.',
s3:'Server-side session',s3d:'After approval, NexAccount stores only the session required to operate.',
cardEyebrow:'TELEGRAM SESSION',cardTitle:'Connect an account',
cardSub:'Scan the QR with Telegram or open the link on the phone already signed in.',
readyTitle:'Ready to create a session',readySub:'The QR is temporary and refreshes automatically.',
start:'Create secure QR',how:'In Telegram: Settings → Devices → Link Desktop Device, then scan the QR.',
scanTitle:'Approve this session in Telegram',scanText:'The QR expires quickly. If it changes, simply scan the new one.',
openTelegram:'Open in Telegram',cancel:'Cancel',
extraTitle:'Additional verification required',
extraText:'Telegram requires an extra step for this account. For your security, NexAI Connect will not ask for your 2FA password on the web.',
retry:'Start again',doneTitle:'Account connected',
doneText:'NexAccount stored the session. NexAI can now operate with this account.',
another:'Connect another account',footer:'NexAI Connect will never ask for your Telegram code or 2FA password.',
creating:'Creating a secure QR…',waiting:'Waiting for approval in Telegram…',
expired:'The QR expired, a new one was generated.',failed:'The connection did not complete. Try again.',connected:'Connected successfully.'
}};

function tr(){document.documentElement.lang=lang;$('langBtn').textContent=lang.toUpperCase();document.querySelectorAll('[data-i18n]').forEach(e=>{const k=e.dataset.i18n;if(t[lang][k])e.textContent=t[lang][k]});document.querySelectorAll('[data-i18n-html]').forEach(e=>{const k=e.dataset.i18nHtml;if(t[lang][k])e.innerHTML=t[lang][k]})}
function msg(text,type='info'){const e=$('status');e.textContent=text;e.className='status show '+type}
function clearMsg(){$('status').className='status'}
function show(name,step){['start','qr','extra','success'].forEach(x=>$(x+'Screen').classList.toggle('active',x===name));document.querySelectorAll('.progress i').forEach((e,i)=>e.classList.toggle('on',i<step));clearMsg()}
function safe(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function setBusy(v){busy=v;$('startBtn').disabled=v;$('retryBtn').disabled=v;$('anotherBtn').disabled=v}
async function request(path,options={}){const r=await fetch(API+path,{...options,cache:'no-store'});const data=await r.json().catch(()=>({}));if(!r.ok||data.ok===false)throw new Error(data.error||('HTTP '+r.status));return data}
async function drawQr(url){if(!url||url===lastQr)return;lastQr=url;await QRCode.toCanvas($('qrCanvas'),url,{width:256,margin:2,errorCorrectionLevel:'M'});$('telegramLink').href=url}
function stopPoll(){if(pollTimer){clearTimeout(pollTimer);pollTimer=null}}
function reset(){stopPoll();pairId='';lastQr='';$('telegramLink').href='#';show('start',1)}
async function handle(state){
  pairId=state.id||pairId;
  if(state.stage==='connected'){
    stopPoll();show('success',3);
    const a=state.account||{};const name=a.username?'@'+a.username:(a.firstName||'Telegram');
    const meta=[a.phoneMasked,a.premium?'Telegram Premium':'Telegram'].filter(Boolean).join(' · ');
    $('accountBox').innerHTML='<b>'+safe(name)+'</b><span>'+safe(meta)+'</span>';
    msg(t[lang].connected,'ok');return;
  }
  if(state.stage==='password_required'){
    stopPoll();show('extra',2);return;
  }
  if(state.stage==='error'||state.stage==='cancelled'||state.stage==='missing'){
    stopPoll();show('start',1);msg(state.error||t[lang].failed,'error');return;
  }
  if(state.stage==='qr'){
    show('qr',2);await drawQr(state.qrUrl);msg(t[lang].waiting,'info');schedulePoll();return;
  }
  schedulePoll();
}
function schedulePoll(){stopPoll();if(!pairId)return;pollTimer=setTimeout(poll,1400)}
async function poll(){try{await handle(await request('?api=qr-status&id='+encodeURIComponent(pairId)))}catch(e){msg(t[lang].failed,'error');schedulePoll()}}
async function start(){
  if(busy)return;setBusy(true);msg(t[lang].creating,'info');
  try{await handle(await request('?api=qr-start',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}))}
  catch(e){show('start',1);msg(t[lang].failed,'error')}
  finally{setBusy(false)}
}
async function cancel(){stopPoll();if(pairId)try{await request('?api=qr-cancel&id='+encodeURIComponent(pairId),{method:'POST'})}catch{}reset()}
$('startBtn').addEventListener('click',start);
$('retryBtn').addEventListener('click',reset);
$('anotherBtn').addEventListener('click',reset);
$('cancelBtn').addEventListener('click',cancel);
$('langBtn').addEventListener('click',()=>{lang=lang==='fr'?'en':'fr';tr()});
window.addEventListener('pagehide',stopPoll);
tr();