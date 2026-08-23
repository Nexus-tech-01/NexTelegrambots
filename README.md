# Nexus Telegram Bots

Dépôt privé de déploiement des 5 bots Telegram Nexus Tech sur **un seul service Render**.

## Bots inclus

- NexGame — `@TheNexGame_bot`
- NexCanal Manager — `@the_big_dipper_bot`
- NexDownloader — `@TheNexDownloader_bot`
- NexGroup Manager — `@DarkNexus01_bot`
- NexStick — `@The_Nexus_techbot`

## Architecture

Les 5 bots restent dans des projets séparés et sont lancés comme des processus Node.js isolés derrière un gateway HTTP unique.

Ils partagent :

- une seule URI MongoDB ;
- une seule base logique `nexus_bots` ;
- des collections séparées/préfixées par bot ;
- un seul service Render public ;
- un système de cross-promotion Nexus intégré.

NexGame utilise également Redis pour l'état temporaire, les files et les verrous rapides.

## Déploiement Render

Ce dépôt est prêt à être relié à Render via un **Blueprint**.

1. Dans Render, crée un nouveau Blueprint.
2. Sélectionne le dépôt privé `Nexus-tech-01/NexTelegrambots`.
3. Render détecte automatiquement `render.yaml`.
4. Renseigne les variables secrètes demandées dans le Dashboard.
5. Lance le déploiement.

Le `Dockerfile` :

- reconstruit le bundle source complet ;
- installe FFmpeg et les workers Python de NexDownloader ;
- installe les dépendances des 5 projets Node.js ;
- compile les projets TypeScript ;
- récupère automatiquement le hostname public Render ;
- lance le préflight ;
- démarre le gateway et les 5 bots.

Une fois le service lancé, `/health` affiche l'état de tous les processus.

## Variables principales

Les secrets sont volontairement **absents de Git**. Utilise `.env.example` comme repère et renseigne-les directement dans Render.

Les principales valeurs sont :

- `NEXUS_MONGODB_URI`
- `NEXGAME__BOT_TOKEN`
- `NEXGAME__REDIS_URL`
- `NEXCANAL__BOT_TOKEN`
- `NEXDOWNLOADER__BOT_TOKEN`
- `NEXDOWNLOADER__OWNER_TELEGRAM_ID`
- `NEXGROUP__TELEGRAM_BOT_TOKEN`
- `NEXGROUP__TELEGRAM_API_ID`
- `NEXGROUP__TELEGRAM_API_HASH`
- `NEXGROUP__NEXGROUP_OWNER_ID`
- `NEXSTICK__BOT_TOKEN`

Les secrets webhook et le secret de signature de paiement peuvent être générés automatiquement par Render grâce à `render.yaml`.

## Source

Le source complet utilisé par Render est conservé dans les fichiers :

`render-src.b64.part-00` → `render-src.b64.part-08`

Le build les concatène, décode l'archive XZ puis extrait le monorepo avant compilation. Aucun token Telegram, mot de passe MongoDB, URL Redis privée ou API hash réel n'est inclus dans ces fichiers.
