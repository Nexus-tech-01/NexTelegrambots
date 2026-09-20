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


## NexAnime ingestion

NexAnime is integrated into the existing NexAccount runtimes and is designed for the paired accounts **@tresor20001** and **@tresor20009**.

Pipeline:

1. discover broadcast channels visible to each listener account;
2. sample recent posts and classify the source as anime, mixed, candidate or non-anime;
3. ignore adult promotions, betting/casino/pronostic posts, crypto/investment spam and generic channel promotion;
4. detect episode releases from caption + filename, including season, episode, language and quality;
5. detect anime presentation posts when an image is paired with structured metadata such as synopsis/genres/studio;
6. scan historical posts for currently active series so a source already at episode 15 can reconstruct earlier episodes;
7. normalize captions and filenames, removing source usernames, t.me links and promotional lines;
8. deduplicate releases globally across both listener accounts;
9. queue live releases ahead of backfill releases and publish them in season/episode order to **@theotaku_nexus**;
10. quarantine ambiguous failures instead of blindly posting them.

The runtime intentionally avoids expensive deep video-content verification. It uses lightweight metadata checks only. Episode reupload is gated by NEXANIME_MEDIA_POLICY; keep the default authorized_only unless the media is licensed/authorized for redistribution.

For file uploads, the destination channel profile image is used as the replacement thumbnail when Telegram accepts a custom thumbnail. Temporary episode files are removed after each upload.
