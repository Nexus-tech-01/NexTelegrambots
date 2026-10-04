# NexControl

NexControl est le centre de contrôle web privé de l’écosystème Nextech.

## Architecture de production

NexControl ne dépend plus d’un workflow GitHub Actions pour son déploiement.

- **Frontend web public** : `https://tresor562.github.io/nexcontrol/`
- **Frontend source** : `Tresor562/Tresor562.github.io/nexcontrol/index.html`
- **Control-plane backend** : Supabase Edge Function `nexcontrol`
- **Passerelle sécurisée navigateur ↔ control-plane** : Supabase Edge Function `nexcontrol-ui`
- **Source de la passerelle** : `nexcontrol/supabase-ui/index.ts`
- **Ancien Vercel** : compatibilité/diagnostic uniquement. Il n’est plus dans le chemin critique de NexControl.
- Les anciens workflows privés `deploy-nexcontrol-vercel.yml` et `check-vercel-secrets.yml` ont été supprimés.

Le site statique est publié par GitHub Pages depuis le dépôt public du portfolio. Aucun workflow NexControl personnalisé, secret Vercel ou minute GitHub Actions privée n’est nécessaire pour publier l’interface.

## Session web sécurisée

Le navigateur ne reçoit jamais le cookie administrateur interne de NexControl.

1. Le frontend envoie les requêtes à `nexcontrol-ui`.
2. Après une authentification administrateur valide, la passerelle conserve le cookie NexControl côté serveur.
3. Le cookie upstream est chiffré en AES-GCM avant stockage dans `public.nxc_web_proxy_sessions`.
4. Le navigateur reçoit uniquement un jeton opaque aléatoire conservé dans `sessionStorage`.
5. Seul le SHA-256 de ce jeton est stocké côté serveur.
6. La session est liée au hash du User-Agent et expire après 8 heures.
7. Les tables de session sont inaccessibles directement aux rôles Supabase `anon` et `authenticated`.
8. Les routes Infrastructure revalident également le cookie administrateur auprès du backend NexControl avant toute lecture ou mutation.

Les origines web autorisées par la passerelle sont explicitement limitées aux domaines NexControl/portfolio configurés dans `nexcontrol/supabase-ui/index.ts`.

## Routage

La passerelle reçoit un chemin dans le paramètre `route`, le valide, puis le transmet au control-plane via `x-nexcontrol-path`.

Les redirections backend sont renvoyées au frontend via `x-nxc-location`, ce qui permet au shell statique de gérer correctement la navigation, le login, le logout et les routes internes sans exposer les cookies cross-origin.

## Sécurité Supabase

Les tables internes suivantes sont protégées par RLS et n’accordent aucun DML direct à `anon` ou `authenticated` :

- `_nxc_hotfix_payload_stage`
- `nxc_nexnews_publications`
- `nxc_operator_audit`
- `nxc_deploy_bundle_chunks`
- `nxc_agent_fleet_members`
- `nxc_external_watchdog_events`
- `nxc_external_watchdog_state`
- `nxc_web_proxy_sessions`

Les fonctions `SECURITY DEFINER` internes de routage de jobs ne sont exécutables que par `service_role`.

## Infrastructure v2

La route administrateur `/infrastructure` est servie par la passerelle `nexcontrol-ui` sous la même session sécurisée que le reste de NexControl.

Elle agrège actuellement :

- les nœuds/VPS enregistrés et leurs métriques récentes ;
- les projets associés à un nœud et à un dépôt GitHub ;
- plusieurs connexions/comptes GitHub simultanés ;
- les watchers de branches GitHub ;
- les health states, alertes, profils de déploiement et plans de release ;
- l'état Auto Deploy par projet.

Le poll GitHub existant reste l'unique watcher (`nexcontrol-github-watch-v2`, toutes les 5 minutes). Les checks de santé et de validation de source continuent dans les jobs existants.

### Garde-fous Auto Deploy

L'interface refuse l'activation d'Auto Deploy si l'un des points suivants n'est pas valide :

- watcher GitHub absent, inactif ou bloqué ;
- bundle/source non vérifié ;
- dérive runtime détectée ;
- stratégie de release non atomique ;
- rollback non prêt.

Le watcher ne crée une entrée de déploiement que si le dépôt est non bloqué **et** que le projet a explicitement `auto_deploy=true`.

### Add VPS

Le bouton **Add VPS** génère un token d'installation à usage unique (15 minutes) et une commande bootstrap.

- le token brut n'est jamais stocké en base, uniquement son SHA-256 ;
- l'agent portable est `ops/nexforge-host-agent.py` ;
- l'installateur est `ops/install-nexforge-host-agent.sh` ;
- le binaire/script téléchargé est épinglé à un commit Git et contrôlé avant installation ;
- après enregistrement, `nexcontrol-host-onboarding-v1` crée automatiquement le nœud NexControl correspondant.

Aucun mot de passe SSH n'est enregistré dans NexControl.

### Add Project

Le bouton **Add Project** permet de choisir simultanément parmi les connexions GitHub déjà enregistrées et les VPS disponibles.

L'onboarding valide :

- l'appartenance du dépôt à l'allowlist de la connexion GitHub ;
- la branche et son SHA Git immuable ;
- le chemin `current` ;
- le service systemd ;
- le fait que la cible actuelle soit un symlink restaurable ;
- la disponibilité de l'agent VPS et du release root.

Un projet n'obtient `rollback_supported=true` qu'après cette vérification runtime.

### Release executor

Le moteur de release utilise `ops/nexcontrol-release-executor.py` et le cron `nexcontrol-deployment-executor-v1`.

Pipeline :

1. récupération de l'exact commit Git ou reconstruction du bundle commit-pinned ;
2. vérification d'intégrité et extraction sans path traversal, symlink, hardlink ou device ;
3. installation des dépendances ;
4. build et checks pré-déploiement ;
5. création d'une release dans `/opt/nex/releases` ;
6. switch atomique du symlink `current` ;
7. restart du service systemd ;
8. health checks locaux puis control-plane ;
9. promotion si healthy ;
10. rollback automatique vers l'ancienne cible en cas d'échec.

Le bouton **Deploy** applique les mêmes gates avant même de créer une ligne `queued`.

### Runtime controls

Le bouton **Manage** d'un projet expose :

- Start ;
- Restart ;
- Stop ;
- les dernières lignes de `journalctl`.

Le navigateur ne choisit jamais un nom de service libre : l'action utilise uniquement `service_name` déjà validé dans `nxc_deploy_profiles`.

### Jobs Infrastructure v2

- `nexcontrol-github-watch-v2` : toutes les 5 minutes ;
- `nexcontrol-node-metrics-v2` : toutes les 5 minutes ;
- `nexcontrol-health-v2` : chaque minute ;
- `nexcontrol-source-validation-v2` : chaque minute ;
- `nexcontrol-host-onboarding-v1` : chaque minute ;
- `nexcontrol-project-verify-v1` : chaque minute ;
- `nexcontrol-deployment-executor-v1` : chaque minute.

La définition SQL source-controlled de cette couche se trouve dans `nexcontrol/sql/infrastructure-v2-control-plane.sql`.

## Fonctions principales

- Dashboard global
- Bots et destinations
- Campagnes et publications
- Tâches et files de livraison
- Supervision des agents
- Contrôle serveur
- Logs et checks
- Contrôle NexAccount / NexAI
- Surfaces de connexion et d’administration associées

## Secrets

Ne jamais commiter :

- mot de passe administrateur NexControl ;
- service-role Supabase ;
- tokens Telegram ;
- credentials MongoDB/Redis ;
- clés de flotte/agent ;
- clés Pterodactyl ;
- secrets Meta/OAuth.

Le frontend GitHub Pages ne contient aucun de ces secrets.
