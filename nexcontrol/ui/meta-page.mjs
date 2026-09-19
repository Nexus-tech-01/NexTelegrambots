import { css } from './styles.mjs';

const X = value => String(value ?? '').replace(
  /[&<>"']/g,
  char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]
);

function yesNo(value) {
  return value ? 'ON' : 'OFF';
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pageCards(pages = []) {
  if (!pages.length) {
    return '<div class="empty">Aucune Page Facebook connectée.</div>';
  }

  return pages.map(page => {
    const tasks = Array.isArray(page.tasks) && page.tasks.length
      ? page.tasks.join(' · ')
      : 'Aucune tâche remontée';

    const webhook = page.webhookSubscribed
      ? '<span class="pill ok">Webhook OK</span>'
      : '<span class="pill bad">Webhook incomplet</span>';

    return `
      <article class="panel" style="padding:22px">
        <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start">
          <div>
            <div class="eyebrow">${page.active ? 'ACTIVE PAGE' : 'CONNECTED PAGE'}</div>
            <h3 style="font-size:30px;letter-spacing:-.05em;margin:10px 0 5px">${X(page.name || page.pageId)}</h3>
            <div class="muted">${X(page.pageId)}</div>
          </div>
          ${webhook}
        </div>
        <p class="muted" style="font-size:12px;line-height:1.5;margin:18px 0">${X(tasks)}</p>
        ${page.webhookError ? `<p style="color:var(--red);font-size:12px">${X(page.webhookError)}</p>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:18px">
          ${page.active ? '' : `<button class="action" data-action="activate_connected_page" data-page="${X(page.pageId)}">Activer</button>`}
          <button class="action" data-action="doctor_page" data-page="${X(page.pageId)}">Doctor</button>
          <button class="action" data-action="subscribe_page_webhooks" data-page="${X(page.pageId)}">Webhook</button>
          <button class="action" data-action="inspect_page_webhooks" data-page="${X(page.pageId)}">Inspecter</button>
          <button class="action" data-action="remove_connected_page" data-page="${X(page.pageId)}">Retirer</button>
        </div>
      </article>
    `;
  }).join('');
}

export function renderMetaPage({
  status = {},
  metrics = {},
  pages = [],
  readiness = {},
  connection = {},
  loadErrors = []
} = {}) {
  const runtime = status.runtime || {};
  const pageState = status.pages || {};
  const active = pageState.activePage;
  const readinessChecks = Array.isArray(readiness.checks)
    ? readiness.checks
    : [];
  const connectionChecks = Array.isArray(connection.checks)
    ? connection.checks
    : [];

  const errors = Array.isArray(loadErrors)
    ? loadErrors.filter(
        item => Array.isArray(item) && item[1]
      )
    : [];

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#080808">
<title>Meta · NexControl</title>
<style>
${css}
.meta-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:20px}
.meta-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}
.meta-span-8{grid-column:span 8}.meta-span-4{grid-column:span 4}.meta-span-12{grid-column:span 12}
.meta-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow:auto;max-height:460px;background:#090909;border:1px solid var(--line);border-radius:16px;padding:14px;color:#bbb;font-size:12px}
@media(max-width:900px){.meta-span-8,.meta-span-4,.meta-span-12{grid-column:span 12}}
</style>
</head>
<body>
<div class="app">
<header class="top">
  <a class="brand" href="/">NEXCONTROL<sup>01</sup></a>
  <a class="action" href="/">Control</a>
</header>
<main class="page">
  <div class="page-head">
    <div>
      <div class="eyebrow">Facebook / Messenger adapter</div>
      <h1 class="page-title">Meta</h1>
    </div>
    <p class="page-sub">OAuth, Pages, webhooks, Messenger, permissions, reprise d’événements et coupe-circuit — sans exposer les tokens Meta au navigateur.</p>
  </div>

  ${errors.length ? `
    <section class="section" style="padding-bottom:0">
      <article class="panel" style="border-color:rgba(255,180,180,.28)">
        <div class="eyebrow">Partial load warning</div>
        <h2 style="font-size:32px;letter-spacing:-.05em;margin:12px 0 18px">NexMeta répond partiellement.</h2>
        <div style="display:grid;gap:8px">
          ${errors.map(([name,message]) => `
            <div style="display:grid;grid-template-columns:120px 1fr;gap:12px;border-top:1px solid var(--line);padding-top:10px">
              <strong style="text-transform:uppercase;font-size:11px;letter-spacing:.08em">${X(name)}</strong>
              <span class="muted" style="font-size:12px">${X(message)}</span>
            </div>
          `).join('')}
        </div>
      </article>
    </section>
  ` : ''}

  <section class="stats">
    <div class="stat">
      <span class="stat-label">Meta configured</span>
      <strong class="stat-num" style="font-size:42px">${status.metaConfigured ? 'YES' : 'NO'}</strong>
    </div>
    <div class="stat">
      <span class="stat-label">Pages</span>
      <strong class="stat-num">${safeNumber(pageState.connectedPages)}</strong>
    </div>
    <div class="stat">
      <span class="stat-label">Webhooks 24h</span>
      <strong class="stat-num">${safeNumber(metrics.webhook24h)}</strong>
    </div>
    <div class="stat">
      <span class="stat-label">Failed / stuck</span>
      <strong class="stat-num" style="font-size:42px">${safeNumber(metrics.webhookFailed)} / ${safeNumber(metrics.webhookStuck)}</strong>
    </div>
  </section>

  <section class="section">
    <div class="meta-grid">
      <article class="panel meta-span-8">
        <div class="eyebrow">Connection</div>
        <h2 style="font-size:44px;letter-spacing:-.06em;margin:10px 0 12px">Facebook Pages</h2>
        <p class="muted">Page active : <strong>${active ? X(active.name || active.pageId) : 'Aucune'}</strong></p>
        <div class="meta-actions">
          <button class="action ${connection.ready ? 'primary' : ''}" id="connectFacebook" ${connection.ready ? '' : 'disabled'}>Connecter Facebook</button>
          <button class="action" data-action="connection_readiness">Vérifier connexion</button>
          <button class="action" data-action="configure_webhooks">Configurer webhooks</button>
          <button class="action" data-action="configure_all_default_messenger_profiles">Profils Messenger</button>
          <button class="action" data-action="doctor_all_pages">Doctor global</button>
          <button class="action" data-action="bridge_status">Bridge details</button>
        </div>
      </article>

      <article class="panel meta-span-4">
        <div class="eyebrow">Emergency control</div>
        <h2 style="font-size:34px;letter-spacing:-.05em;margin:10px 0 22px">Kill switch</h2>
        <div style="display:grid;gap:12px">
          <button class="action ${runtime.inboundEnabled ? 'primary' : ''}" id="toggleInbound">Inbound ${yesNo(runtime.inboundEnabled)}</button>
          <button class="action ${runtime.outboundEnabled ? 'primary' : ''}" id="toggleOutbound">Outbound ${yesNo(runtime.outboundEnabled)}</button>
        </div>
      </article>

      <article class="panel meta-span-12">
        <div class="eyebrow">Facebook connection readiness</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 22px">
          <span class="pill ${connection.ready ? 'ok' : 'bad'}">Facebook Login ${connection.ready ? 'READY' : 'NOT READY'}</span>
          ${connection.urls?.oauthCallback ? `<span class="pill">${X(connection.urls.oauthCallback)}</span>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px">
          ${connectionChecks.map(item => `
            <div style="border-top:1px solid var(--line);padding:12px 2px">
              <span class="pill ${item.ok ? 'ok' : 'bad'}">${item.ok ? 'OK' : 'MISSING'}</span>
              <div style="font-weight:650;margin-top:9px">${X(item.name)}</div>
              <div class="muted" style="font-size:12px;margin-top:4px">${X(item.detail)}</div>
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel meta-span-12">
        <div class="eyebrow">Deployment readiness</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 22px">
          <span class="pill ${readiness.adapterReady ? 'ok' : 'bad'}">Adapter ${readiness.adapterReady ? 'READY' : 'NOT READY'}</span>
          <span class="pill ${readiness.bridgeReady ? 'ok' : 'bad'}">Nexus Bridge ${readiness.bridgeReady ? 'READY' : 'NOT READY'}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px">
          ${readinessChecks.map(item => `
            <div style="border-top:1px solid var(--line);padding:12px 2px">
              <span class="pill ${item.ok ? 'ok' : 'bad'}">${item.ok ? 'OK' : 'MISSING'}</span>
              <div style="font-weight:650;margin-top:9px">${X(item.name)}</div>
              <div class="muted" style="font-size:12px;margin-top:4px">${X(item.detail)}</div>
            </div>
          `).join('')}
        </div>
      </article>

      <article class="panel meta-span-12">
        <div class="eyebrow">Connected Pages</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-top:20px">
          ${pageCards(pages)}
        </div>
      </article>

      <article class="panel meta-span-4">
        <div class="eyebrow">Messenger 24h</div>
        <div class="big-value" style="margin-top:20px">${safeNumber(metrics.messages24h)}</div>
        <p class="muted">${safeNumber(metrics.inbound24h)} inbound · ${safeNumber(metrics.outbound24h)} outbound</p>
      </article>

      <article class="panel meta-span-4">
        <div class="eyebrow">Identities</div>
        <div class="big-value" style="margin-top:20px">${safeNumber(metrics.identities)}</div>
        <p class="muted">${safeNumber(metrics.linkedIdentities)} liées à Nexus</p>
      </article>

      <article class="panel meta-span-4">
        <div class="eyebrow">Runtime</div>
        <p style="font-size:18px;line-height:1.6;margin-top:20px">
          Inbound <strong>${yesNo(runtime.inboundEnabled)}</strong><br>
          Outbound <strong>${yesNo(runtime.outboundEnabled)}</strong><br>
          Secrets exposed <strong>${status.secretExposure ? 'YES' : 'NO'}</strong>
        </p>
      </article>

      <article class="panel meta-span-12">
        <div class="eyebrow">Operations output</div>
        <pre id="metaOut" class="meta-code">Ready.</pre>
      </article>
    </div>
  </section>
</main>
</div>

<script>
const out=document.getElementById('metaOut');

async function metaAction(action,payload={}){
  out.textContent='Running '+action+'…';
  const response=await fetch('/api/admin/meta/action',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({action,...payload})
  });
  const data=await response.json().catch(()=>({error:'invalid_response'}));
  out.textContent=JSON.stringify(data,null,2);
  if(!response.ok)throw new Error(data.message||data.error||'request_failed');
  return data;
}

document.getElementById('connectFacebook').onclick=async()=>{
  try{
    const data=await metaAction('oauth_start');
    const url=data?.result?.authorizationUrl;
    if(url)location.href=url;
  }catch(e){}
};

document.getElementById('toggleInbound').onclick=async()=>{
  try{
    await metaAction('set_runtime',{inboundEnabled:${runtime.inboundEnabled ? 'false' : 'true'}});
    location.reload();
  }catch(e){}
};

document.getElementById('toggleOutbound').onclick=async()=>{
  try{
    await metaAction('set_runtime',{outboundEnabled:${runtime.outboundEnabled ? 'false' : 'true'}});
    location.reload();
  }catch(e){}
};

document.addEventListener('click',async e=>{
  const button=e.target.closest('[data-action]');
  if(!button)return;
  const action=button.dataset.action;
  const pageId=button.dataset.page;
  try{
    await metaAction(action,pageId?{pageId}:{});
    if(['activate_connected_page','remove_connected_page','subscribe_page_webhooks','configure_webhooks','configure_all_default_messenger_profiles'].includes(action)){
      setTimeout(()=>location.reload(),350);
    }
  }catch(e){}
});
</script>
</body>
</html>`;
}
