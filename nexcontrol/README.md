# NexControl V1

NexControl est le centre de contrôle web de l’écosystème Nextech.

## Architecture actuelle

Le déploiement de NexControl **ne dépend plus de GitHub Actions**.

- Backend/control-plane : Supabase Edge Function `nexcontrol`.
- Passerelle web : Supabase Edge Function `nexcontrol-ui`.
- Source de la passerelle : `nexcontrol/supabase-ui/index.ts`.
- URL web directe :
  `https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexcontrol-ui/`
- L’ancien projet Vercel peut rester comme proxy/alias historique, mais il n’est plus la chaîne de déploiement obligatoire de NexControl.
- Les workflows GitHub Actions dédiés au déploiement Vercel de NexControl ont été supprimés.

## Pourquoi cette architecture

Le compte GitHub de l’organisation avait épuisé ses minutes GitHub Actions, ce qui bloquait les déploiements avant même le démarrage des jobs. La passerelle web est désormais déployable directement sur Supabase, indépendamment du quota GitHub Actions.

La passerelle :
- transmet les requêtes au backend `nexcontrol`;
- conserve les cookies de session;
- transmet les routes API;
- force les pages UI en `text/html; charset=utf-8`;
- retire le CSP `sandbox` problématique et applique un CSP adapté;
- réécrit les chemins absolus pour fonctionner sous `/functions/v1/nexcontrol-ui/`;
- désactive le cache pour les pages d’administration.

## Déploiement de la passerelle

Le fichier de référence est :

```
nexcontrol/supabase-ui/index.ts
```

La fonction Supabase à mettre à jour est :

```
nexcontrol-ui
```

Elle doit rester avec `verify_jwt=false`, car l’authentification administrateur est gérée par NexControl lui-même via ses cookies/session. Il ne faut pas exposer directement les tables internes Supabase aux clients.

## Sécurité Supabase

Les tables internes NexControl utilisent RLS et les rôles `anon` / `authenticated` n’ont pas d’accès direct. Les opérations administratives passent par le control-plane serveur avec le rôle de service.

Les RPC `SECURITY DEFINER` de routage interne ne sont pas exécutables par `anon` ou `authenticated`.

## Fonctions incluses

- Dashboard global : bots, destinations, campagnes, tâches et état des agents.
- Enregistrement et supervision de la flotte.
- Synchronisation des droits Telegram.
- File de livraison multi-bot.
- Gestion des campagnes immédiates ou programmées.
- Contrôle serveur/agents.
- Authentification administrateur par cookie signé HttpOnly.
- Contrôle NexAccount / NexAI et surfaces Meta associées.

## Connexion de la flotte

La flotte utilise notamment :

```env
NEXCONTROL_URL=https://ojbyvjqurlamplmujmyu.supabase.co/functions/v1/nexcontrol-ui/
NEXCONTROL_FLEET_KEY=<clé de flotte>
```

Les secrets réels ne doivent jamais être commités dans Git.

## Limitation Telegram importante

Telegram Bot API ne fournit pas une méthode globale permettant de demander la liste complète de tous les groupes d’un bot. NexControl construit donc son registre à partir des updates reçues, des chats déjà connus et des vérifications de permissions Telegram.
