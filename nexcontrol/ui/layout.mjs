import { css, commonScript } from './styles.mjs';
import { X } from '../lib/core.mjs';

function nav(active=''){
  const item=(href,label,key)=>`<a href="${href}"${active===key?' aria-current="page"':''}>${label}</a>`;
  return `<header class="top"><a class="brand" href="/">NEXCONTROL<sup>01</sup></a><button class="menu-btn" aria-label="Menu"><span class="menu-icon"></span></button></header>
  <aside class="overlay"><div class="overlay-inner"><nav>${item('/','Control','home')}${item('/bots','Bots','bots')}${item('/destinations','Destinations','destinations')}${item('/campaigns','Campagnes','campaigns')}${item('/campaigns/new','Publier','compose')}${item('/server','Server','server')}</nav><div class="overlay-side"><p>Centre de commande pour toute la flotte Nex. Contrôle, publications, permissions, fichiers, logs et automatisations depuis une seule interface.</p><form method="post" action="/api/admin/logout"><button class="logout">Déconnexion</button></form></div></div></aside>`;
}

export function page(title,content,active=''){
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#080808"><title>${X(title)} · NexControl</title><style>${css}</style></head><body><div class="app">${nav(active)}<main class="page">${content}</main></div>${commonScript}</body></html>`;
}

export function loginPage(){
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#080808"><title>Connexion · NexControl</title><style>${css}</style></head><body><div class="login-wrap"><section class="login-art"><a class="brand" href="#">NEXCONTROL<sup>01</sup></a><div><div class="eyebrow">Private operations console</div><div class="display">One<br><span class="soft">control</span><br>surface.</div></div><p class="micro">Nextech infrastructure · private access only.</p></section><section class="login-box"><div class="login-card"><div class="eyebrow">Authentication</div><h1>Welcome back.</h1><p>Accède à la flotte, aux destinations, aux permissions de publication et aux campagnes.</p><form method="post" action="/api/admin/login"><input type="password" name="password" placeholder="Mot de passe administrateur" required autofocus><button class="action primary">Entrer dans NexControl →</button></form></div></section></div></body></html>`;
}
