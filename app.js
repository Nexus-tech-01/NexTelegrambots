import QRCode from 'https://esm.sh/qrcode@1.5.4?bundle';

const API='https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexai-connect';
const $=id=>document.getElementById(id);
let lang='fr';
let activeMethod='phone';
let phonePairId='';
let qrPairId='';
let qrTimer=null;
let publicKey=null;
let busy=false;
let lastQr='';
let gatewayState='checking';

const i18n={
  fr:{
    secure:'Connexion sécurisée',eyebrow:'COMPTE TELEGRAM',title:'Connecter Telegram',
    subtitle:'Choisis comment tu veux autoriser ce compte.',byPhone:'Par numéro',byQr:'QR code',
    phoneTitle:'Ton numéro Telegram',phoneText:'Telegram va envoyer un code de connexion au compte associé à ce numéro.',
    phoneLabel:'Numéro de téléphone',sendCode:'Recevoir le code',back:'Retour',
    codeTitle:'Entre le code',codeText:'Un code vient d’être envoyé par Telegram.',codeLabel:'Code de connexion',verify:'Vérifier',
    passwordTitle:'Vérification 2FA',passwordText:'Telegram demande le mot de passe de vérification en deux étapes de ce compte.',
    passwordLabel:'Mot de passe 2FA',finish:'Terminer',
    qrTitle:'Connecter avec un QR',qrText:'Ouvre Telegram → Paramètres → Appareils → Lier un appareil.',
    createQr:'Créer le QR',scanTitle:'Scanne avec Telegram',scanText:'Le QR se renouvelle automatiquement s’il expire.',
    openTelegram:'Ouvrir dans Telegram',cancel:'Annuler',qr2faTitle:'2FA requis',
    qr2faText:'Telegram exige une vérification supplémentaire. Utilise l’option « Par numéro » pour terminer la connexion avec le mot de passe 2FA.',
    usePhone:'Utiliser le numéro',successTitle:'Compte connecté',successText:'La session Telegram est maintenant active dans NexAI.',
    another:'Connecter un autre compte',gatewayOnline:'Passerelle active',gatewayOffline:'Passerelle indisponible',gatewayChecking:'Vérification passerelle…',encrypted:'Code et 2FA chiffrés',multi:'Multi-session',
    sending:'Demande du code à Telegram…',codeSent:'Code envoyé. Vérifie Telegram.',codeViaApp:'Code envoyé dans ton application Telegram.',
    verifying:'Vérification…',connecting:'Connexion…',creatingQr:'Création du QR…',waitingQr:'En attente de validation dans Telegram…',
    menuOpen:'Ouvrir le menu',menuClose:'Fermer le menu'
  },
  en:{
    secure:'Secure connection',eyebrow:'TELEGRAM ACCOUNT',title:'Connect Telegram',
    subtitle:'Choose how you want to authorize this account.',byPhone:'Phone number',byQr:'QR code',
    phoneTitle:'Your Telegram number',phoneText:'Telegram will send a login code to the account linked to this number.',
    phoneLabel:'Phone number',sendCode:'Send login code',back:'Back',
    codeTitle:'Enter the code',codeText:'Telegram just sent a login code.',codeLabel:'Login code',verify:'Verify',
    passwordTitle:'2FA verification',passwordText:'Telegram requires this account’s two-step verification password.',
    passwordLabel:'2FA password',finish:'Finish',
    qrTitle:'Connect with QR',qrText:'Open Telegram → Settings → Devices → Link Desktop Device.',
    createQr:'Create QR',scanTitle:'Scan with Telegram',scanText:'The QR refreshes automatically when it expires.',
    openTelegram:'Open in Telegram',cancel:'Cancel',qr2faTitle:'2FA required',
    qr2faText:'Telegram requires an additional verification step. Use the phone-number option to finish with your 2FA password.',
    usePhone:'Use phone number',successTitle:'Account connected',successText:'The Telegram session is now active in NexAI.',
    another:'Connect another account',gatewayOnline:'Gateway online',gatewayOffline:'Gateway unavailable',gatewayChecking:'Checking gateway…',encrypted:'Code and 2FA encrypted',multi:'Multi-session',
    sending:'Requesting a code from Telegram…',codeSent:'Code sent. Check Telegram.',codeViaApp:'Code sent inside your Telegram app.',
    verifying:'Verifying…',connecting:'Connecting…',creatingQr:'Creating QR…',waitingQr:'Waiting for approval in Telegram…',
    menuOpen:'Open menu',menuClose:'Close menu'
  }
};

function tr(){
  document.documentElement.lang=lang;
  $('langBtn').textContent=lang.toUpperCase();
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    const key=el.dataset.i18n;
    if(i18n[lang][key])el.textContent=i18n[lang][key];
  });
  if($('menuToggle'))$('menuToggle').setAttribute('aria-label',document.body.classList.contains('menu-open')?i18n[lang].menuClose:i18n[lang].menuOpen);
  renderGatewayState();
}
function status(id,text,type='info'){
  const el=$(id);
  el.textContent=text||'';
  el.className='inline-status'+(text?' show '+type:'');
  if(text&&type==='error'){
    requestAnimationFrame(()=>{el.classList.remove('status-shake');void el.offsetWidth;el.classList.add('status-shake')});
  }
}
function setBusy(button,on,label){
  busy=on;
  button.disabled=on;
  if(on){
    button.dataset.original=button.innerHTML;
    button.innerHTML='<span><i class="busy-dot"></i>'+label+'</span>';
  }else if(button.dataset.original){
    button.innerHTML=button.dataset.original;
  }
}
function showStage(id){
  ['phoneStart','codeStage','passwordStage'].forEach(x=>$(x).classList.toggle('active',x===id));
}
function showQr(id){
  ['qrIdle','qrLive','qrPasswordRequired'].forEach(x=>$(x).classList.toggle('active',x===id));
}
let methodAnimation=null;
function applyMethod(method){
  activeMethod=method;
  const qr=method==='qr';
  $('phoneTab').classList.toggle('active',!qr);
  $('qrTab').classList.toggle('active',qr);
  $('phoneTab').setAttribute('aria-selected',String(!qr));
  $('qrTab').setAttribute('aria-selected',String(qr));
  document.querySelector('.method-tabs').classList.toggle('qr',qr);
  $('phonePanel').classList.toggle('active',!qr);
  $('qrPanel').classList.toggle('active',qr);
  $('successPanel').classList.remove('active');
}
function setMethod(method){
  const area=document.querySelector('.method-area');
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(method===activeMethod||reduced||!area.animate){applyMethod(method);return}
  const dir=method==='qr'?-1:1;
  methodAnimation?.cancel();
  const out=area.animate(
    [{opacity:1,transform:'translateX(0)'},{opacity:0,transform:'translateX('+(dir*12)+'px)'}],
    {duration:135,easing:'cubic-bezier(.4,0,.2,1)',fill:'forwards'}
  );
  methodAnimation=out;
  out.onfinish=()=>{
    applyMethod(method);
    const incoming=area.animate(
      [{opacity:0,transform:'translateX('+(-dir*14)+'px)'},{opacity:1,transform:'translateX(0)'}],
      {duration:245,easing:'cubic-bezier(.16,1,.3,1)',fill:'forwards'}
    );
    methodAnimation=incoming;
    incoming.onfinish=()=>{area.style.opacity='';area.style.transform=''};
  };
}
function renderGatewayState(){
  const label=document.querySelector('[data-i18n="gatewayOnline"]');
  if(!label)return;
  const key=gatewayState==='online'?'gatewayOnline':gatewayState==='offline'?'gatewayOffline':'gatewayChecking';
  label.textContent=i18n[lang][key];
  const dot=label.parentElement?.querySelector('i');
  if(dot)dot.className=gatewayState==='online'?'green':gatewayState==='offline'?'red':'checking';
}
async function probeGateway(){
  gatewayState='checking';renderGatewayState();
  try{await getPublicKey(true);gatewayState='online'}
  catch{gatewayState='offline'}
  renderGatewayState();
}
function pemToBuffer(pem){
  const b64=String(pem).replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g,'');
  const raw=atob(b64);
  return Uint8Array.from(raw,c=>c.charCodeAt(0)).buffer;
}
async function getPublicKey(force=false){
  if(force)publicKey=null;
  if(publicKey)return publicKey;
  const r=await fetch(API+'?api=pair-key',{cache:'no-store'});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data.publicKey)throw new Error(data.error||'pairing_key_unavailable');
  publicKey=await crypto.subtle.importKey('spki',pemToBuffer(data.publicKey),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  return publicKey;
}
async function secure(payload,retryFreshKey=true){
  const key=await getPublicKey();
  const clear=new TextEncoder().encode(JSON.stringify(payload));
  const encrypted=await crypto.subtle.encrypt({name:'RSA-OAEP'},key,clear);
  const bytes=new Uint8Array(encrypted);
  let raw='';
  for(const b of bytes)raw+=String.fromCharCode(b);
  const envelope=btoa(raw);
  const r=await fetch(API+'?api=pair-secure',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({envelope}),cache:'no-store'
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok){
    const code=String(data?.error||'').toLowerCase();
    if(retryFreshKey&&(code.includes('pairing_service_failed')||code.includes('pairing_gateway_error')||code.includes('pairing_key'))){
      await getPublicKey(true);
      return secure(payload,false);
    }
    throw Object.assign(new Error(data.error||'pairing_failed'),{data});
  }
  return data;
}
async function api(path,options={}){
  const r=await fetch(API+path,{...options,cache:'no-store'});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||data.ok===false)throw Object.assign(new Error(data.error||('HTTP '+r.status)),{data});
  return data;
}
function friendly(data,fallback){
  const code=String(data?.errorCode||data?.error||fallback||'').toUpperCase();
  if(code.includes('PHONE_NUMBER_INVALID')||code.includes('INVALID TELEGRAM PHONE'))return lang==='fr'?'Ce numéro Telegram n’est pas valide.':'This Telegram number is invalid.';
  if(code.includes('PHONE_CODE_INVALID')||code.includes('PHONE_CODE_EMPTY'))return lang==='fr'?'Le code est incorrect.':'The code is incorrect.';
  if(code.includes('PHONE_CODE_EXPIRED'))return lang==='fr'?'Le code a expiré. Recommence la connexion.':'The code expired. Start again.';
  if(code.includes('PASSWORD_HASH_INVALID')||code.includes('PASSWORD_EMPTY'))return lang==='fr'?'Le mot de passe 2FA est incorrect.':'The 2FA password is incorrect.';
  if(code.includes('SIGN_UP_REQUIRED'))return lang==='fr'?'Ce numéro n’est pas encore associé à un compte Telegram.':'This number is not linked to a Telegram account yet.';
  if(code.includes('FLOOD'))return lang==='fr'?'Telegram demande d’attendre avant une nouvelle tentative.':'Telegram asked you to wait before trying again.';
  if(code.includes('AGENT_OFFLINE')||code.includes('SERVICE_FAILED')||code.includes('GATEWAY'))return lang==='fr'?'La passerelle de connexion est momentanément indisponible.':'The connection gateway is temporarily unavailable.';
  return fallback||(lang==='fr'?'La connexion n’a pas abouti. Réessaie.':'Connection failed. Try again.');
}
function success(account={}){
  stopQrPoll();
  $('phonePanel').classList.remove('active');
  $('qrPanel').classList.remove('active');
  $('successPanel').classList.remove('active');
  void $('successPanel').offsetWidth;
  $('successPanel').classList.add('active');
  const card=$('connectCard');
  card.classList.remove('success-glow');void card.offsetWidth;card.classList.add('success-glow');
  setTimeout(()=>card.classList.remove('success-glow'),1500);
  const name=account.username?'@'+account.username:(account.firstName||'Telegram');
  const meta=[account.phoneMasked,account.premium?'Telegram Premium':'Telegram'].filter(Boolean).join(' · ');
  $('accountCard').innerHTML='<b></b><span></span>';
  $('accountCard').querySelector('b').textContent=name;
  $('accountCard').querySelector('span').textContent=meta;
}
function handlePhoneState(state){
  phonePairId=String(state.id||phonePairId||'');
  if(state.stage==='code'){
    showStage('codeStage');
    const codeStage=$('codeStage');
    codeStage.classList.remove('code-received');void codeStage.offsetWidth;codeStage.classList.add('code-received');
    $('codeHelp').textContent=state.codeViaApp?i18n[lang].codeViaApp:i18n[lang].codeSent;
    setTimeout(()=>$('codeInput').focus(),160);
    if(state.error||state.errorCode)status('codeStatus',friendly(state),'error');
    else status('codeStatus','','info');
    return;
  }
  if(state.stage==='password'){
    showStage('passwordStage');
    setTimeout(()=>$('passwordInput').focus(),160);
    if(state.error||state.errorCode)status('passwordStatus',friendly(state),'error');
    return;
  }
  if(state.stage==='connected'){success(state.account||{});return}
  if(state.stage==='error'||state.stage==='missing'||state.stage==='cancelled'){
    throw Object.assign(new Error(state.error||state.errorCode||'pairing_failed'),{data:state});
  }
}
async function startPhone(){
  if(busy)return;
  status('phoneStatus','');
  let phone=$('phoneInput').value.trim().replace(/[()\s-]/g,'');
  if(!/^\+?[0-9]{7,16}$/.test(phone)){
    status('phoneStatus',lang==='fr'?'Entre un numéro au format international.':'Enter a phone number in international format.','error');return;
  }
  const btn=$('sendCodeBtn');
  setBusy(btn,true,i18n[lang].sending);
  status('phoneStatus',i18n[lang].sending,'info');
  try{
    const state=await secure({action:'pair-start',phone});
    handlePhoneState(state);
    status('phoneStatus','');
  }catch(e){status('phoneStatus',friendly(e.data,e.message),'error')}
  finally{setBusy(btn,false,'')}
}
async function submitCode(){
  if(busy)return;
  const code=$('codeInput').value.trim();
  if(!code){status('codeStatus',lang==='fr'?'Entre le code reçu dans Telegram.':'Enter the code received in Telegram.','error');return}
  const btn=$('verifyCodeBtn');
  setBusy(btn,true,i18n[lang].verifying);
  status('codeStatus',i18n[lang].verifying,'info');
  try{handlePhoneState(await secure({action:'pair-code',id:phonePairId,code}))}
  catch(e){status('codeStatus',friendly(e.data,e.message),'error')}
  finally{setBusy(btn,false,'')}
}
async function submitPassword(){
  if(busy)return;
  const password=$('passwordInput').value;
  if(!password){status('passwordStatus',lang==='fr'?'Entre ton mot de passe 2FA.':'Enter your 2FA password.','error');return}
  const btn=$('verifyPasswordBtn');
  setBusy(btn,true,i18n[lang].connecting);
  status('passwordStatus',i18n[lang].connecting,'info');
  try{handlePhoneState(await secure({action:'pair-password',id:phonePairId,password}))}
  catch(e){status('passwordStatus',friendly(e.data,e.message),'error')}
  finally{setBusy(btn,false,'')}
}
async function drawQr(url){
  if(!url||url===lastQr)return;
  lastQr=url;
  await QRCode.toCanvas($('qrCanvas'),url,{width:264,margin:2,errorCorrectionLevel:'M'});
  $('telegramLink').href=url;
}
function stopQrPoll(){if(qrTimer){clearTimeout(qrTimer);qrTimer=null}}
function scheduleQr(){stopQrPoll();if(qrPairId)qrTimer=setTimeout(pollQr,1400)}
async function handleQr(state){
  qrPairId=String(state.id||qrPairId||'');
  if(state.stage==='connected'){success(state.account||{});return}
  if(state.stage==='password_required'){stopQrPoll();showQr('qrPasswordRequired');return}
  if(state.stage==='qr'){
    showQr('qrLive');
    await drawQr(state.qrUrl);
    status('qrLiveStatus',i18n[lang].waitingQr,'info');
    scheduleQr();
    return;
  }
  if(state.stage==='error'||state.stage==='missing'||state.stage==='cancelled'){
    stopQrPoll();showQr('qrIdle');status('qrStatus',friendly(state),'error');return;
  }
  scheduleQr();
}
async function startQr(){
  if(busy)return;
  const btn=$('createQrBtn');
  setBusy(btn,true,i18n[lang].creatingQr);
  status('qrStatus',i18n[lang].creatingQr,'info');
  try{
    const state=await api('?api=qr-start',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    status('qrStatus','');
    await handleQr(state);
  }catch(e){status('qrStatus',friendly(e.data,e.message),'error')}
  finally{setBusy(btn,false,'')}
}
async function pollQr(){
  if(!qrPairId)return;
  try{await handleQr(await api('?api=qr-status&id='+encodeURIComponent(qrPairId)))}
  catch(e){status('qrLiveStatus',friendly(e.data,e.message),'error');scheduleQr()}
}
async function cancelQr(){
  stopQrPoll();
  if(qrPairId){try{await api('?api=qr-cancel&id='+encodeURIComponent(qrPairId),{method:'POST'})}catch{}}
  qrPairId='';lastQr='';showQr('qrIdle');status('qrStatus','');
}
function resetAll(){
  stopQrPoll();
  phonePairId='';qrPairId='';lastQr='';
  ['phoneInput','codeInput','passwordInput'].forEach(id=>$(id).value='');
  ['phoneStatus','codeStatus','passwordStatus','qrStatus','qrLiveStatus'].forEach(id=>status(id,''));
  showStage('phoneStart');showQr('qrIdle');setMethod('phone');
}
function setMenu(open){
  document.body.classList.toggle('menu-open',open);
  $('menuLayer').classList.toggle('open',open);
  $('menuLayer').setAttribute('aria-hidden',open?'false':'true');
  $('menuToggle').setAttribute('aria-expanded',String(open));
  $('menuToggle').setAttribute('aria-label',open?i18n[lang].menuClose:i18n[lang].menuOpen);
}
function toggleSection(name){
  document.querySelectorAll('[data-menu-section]').forEach(trigger=>{
    const own=trigger.dataset.menuSection;
    const open=own===name&&!trigger.classList.contains('active');
    trigger.classList.toggle('active',open);
    trigger.setAttribute('aria-expanded',String(open));
    const panel=document.querySelector('[data-menu-panel="'+own+'"]');
    if(panel)panel.classList.toggle('open',open);
  });
}
function startup(){
  const reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(()=>document.body.classList.add('ready'),reduce?40:950);
  if(!reduce){
    let tx=50,ty=50,cx=50,cy=50,raf=0;
    const tick=()=>{cx+=(tx-cx)*.08;cy+=(ty-cy)*.08;document.documentElement.style.setProperty('--mx',cx+'%');document.documentElement.style.setProperty('--my',cy+'%');raf=requestAnimationFrame(tick)};
    window.addEventListener('pointermove',e=>{tx=e.clientX/window.innerWidth*100;ty=e.clientY/window.innerHeight*100},{passive:true});
    raf=requestAnimationFrame(tick);
    window.addEventListener('pagehide',()=>cancelAnimationFrame(raf),{once:true});
  }
}

$('menuToggle').addEventListener('click',()=>setMenu(!document.body.classList.contains('menu-open')));
$('menuBackdrop').addEventListener('click',()=>setMenu(false));
$('menuClose').addEventListener('click',()=>setMenu(false));
document.querySelectorAll('[data-menu-section]').forEach(trigger=>trigger.addEventListener('click',()=>toggleSection(trigger.dataset.menuSection)));
document.querySelectorAll('.side-menu a[target="_blank"]').forEach(link=>link.addEventListener('click',()=>setMenu(false)));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('menu-open'))setMenu(false)});
$('phoneTab').addEventListener('click',()=>setMethod('phone'));
$('qrTab').addEventListener('click',()=>setMethod('qr'));
$('sendCodeBtn').addEventListener('click',startPhone);
$('verifyCodeBtn').addEventListener('click',submitCode);
$('verifyPasswordBtn').addEventListener('click',submitPassword);
$('createQrBtn').addEventListener('click',startQr);
$('cancelQrBtn').addEventListener('click',cancelQr);
$('switchToPhoneBtn').addEventListener('click',()=>{setMethod('phone');showStage('phoneStart')});
$('anotherAccountBtn').addEventListener('click',resetAll);
$('backPhoneBtn').addEventListener('click',()=>showStage('phoneStart'));
$('backCodeBtn').addEventListener('click',()=>showStage('codeStage'));
$('togglePassword').addEventListener('click',()=>{$('passwordInput').type=$('passwordInput').type==='password'?'text':'password'});
$('langBtn').addEventListener('click',()=>{lang=lang==='fr'?'en':'fr';tr()});
$('phoneInput').addEventListener('keydown',e=>{if(e.key==='Enter')startPhone()});
$('codeInput').addEventListener('keydown',e=>{if(e.key==='Enter')submitCode()});
$('passwordInput').addEventListener('keydown',e=>{if(e.key==='Enter')submitPassword()});
$('codeInput').addEventListener('input',()=>{
  const el=$('codeInput');el.classList.remove('code-pulse');void el.offsetWidth;el.classList.add('code-pulse');
});
window.addEventListener('pagehide',stopQrPoll);
tr();startup();probeGateway();
