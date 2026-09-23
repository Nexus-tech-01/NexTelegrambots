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
