(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let fingerprint = '', source = '', waiting = false;
  const state = () => [$('host').value, $('port').value, $('username').value, $('admin').value].join('|');
  const status = (s, type) => { $('status').textContent=s; $('status').className='status '+(type||''); };
  const errors = {
    unauthorized:'Code administrateur incorrect.',
    ssh_gateway_not_configured:'La fonction SSH doit être activée dans les réglages Vercel.',
    host_not_allowed:'Cette adresse ou ce port SSH ne sont pas autorisés.',
    ssh_authentication_failed:'Identifiants SSH refusés par le serveur.',
    ssh_connection_failed:'Connexion SSH impossible.',
    ssh_timeout:'La connexion SSH a expiré.',
    origin_mismatch:'Origine non autorisée.',
    host_key_changed:'Empreinte SSH différente : vérifie le serveur avant de continuer.'
  };
  const enable = () => {
    $('probe').disabled=waiting;
    const ready=!waiting && fingerprint && source===state() && $('confirm-fingerprint').checked;
    $('connect').disabled=!ready; $('run').disabled=!ready;
  };
  function reset() {
    fingerprint='';source='';
    $('confirm-fingerprint').checked=false;
    $('fingerprint-panel').style.display='none';enable();
  }
  for(const field of ['host','port','username','admin']) $(field).addEventListener('input',reset);
  $('confirm-fingerprint').addEventListener('change',enable);
  async function call(mode, command) {
    if(waiting)return null;
    waiting=true;enable();status('Connexion en cours…');
    const controller = new AbortController();
    const timer=setTimeout(()=>controller.abort(),28000);
    try {
      const response=await fetch('/ssh-connect',{
        method:'POST',cache:'no-store',credentials:'omit',
        headers:{'content-type':'application/json','x-nxc-ssh-token':$('admin').value},
        body:JSON.stringify({
          host:$('host').value.trim(),port:Number($('port').value),
          username:$('username').value.trim(),mode,
          password:mode==='exec'?$('password').value:undefined,
          fingerprint:mode==='exec'?fingerprint:undefined,
          command
        }),signal:controller.signal
      });
      const data=await response.json();
      if(!response.ok)throw new Error(errors[data.error]||data.error||('HTTP '+response.status));
      return data;
    } catch(error) {
      status(error.name==='AbortError'?'Connexion expirée.':error.message,'error');
      return null;
    } finally {clearTimeout(timer);waiting=false;enable();}
  }
  $('probe').addEventListener('click',async()=>{
    reset();
    const d=await call('fingerprint');
    if(!d)return;
    fingerprint=d.fingerprint; source=state();
    $('fingerprint').textContent=fingerprint;
    $('fingerprint-panel').style.display='block';
    status('Compare cette empreinte à celle de ton hébergeur avant de confirmer.','good');
    enable();
  });
  async function exec(command) {
    if(!fingerprint || !$('confirm-fingerprint').checked || source!==state()) {
      status('Vérifie et confirme la clé du serveur avant de te connecter.','error');return;
    }
    if(!$('password').value){status('Mot de passe SSH requis.','error');return;}
    const d=await call('exec',command);
    if(!d)return;
    $('output').textContent=(d.stdout||'')+(d.stderr?'\n[stderr]\n'+d.stderr:'')+'\n[code sortie: '+d.exitCode+']';
    status('Commande terminée.','good');
  }
  $('connect').addEventListener('click',()=>exec('whoami && hostname && uptime'));
  $('run').addEventListener('click',()=>exec($('command').value));
  $('clear').addEventListener('click',()=>{$('output').textContent='';});
  // Secrets are generated locally using the browser CSPRNG, not stored in cookies or localStorage.
  $('generate-admin').addEventListener('click', () => {
    if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
      $('generate-status').textContent='Impossible de générer un secret sécurisé : ouvre cette page en HTTPS.';
      return;
    }
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    const value = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    $('new-admin').value = value;
    $('admin').value = value;
    reset();
    $('copy-admin').disabled = false;
    $('generate-status').textContent='Code généré uniquement sur ton appareil. Copie-le dans NXC_SSH_ADMIN_TOKEN sur Vercel, puis redéploie.';
  });
  $('copy-admin').addEventListener('click', async () => {
    const value = $('new-admin').value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      $('generate-status').textContent='Code copié. Colle-le uniquement dans les variables d’environnement de Vercel.';
    } catch {
      $('new-admin').type = 'text';
      $('new-admin').focus();
      $('new-admin').select();
      $('generate-status').textContent='Copie manuellement le code sélectionné, uniquement dans Vercel.';
    }
  });
})();