# Nexus Telegram Bots

Private deployment repository for the Nexus Tech Telegram bot monorepo.

It runs five bots on one Render web service:

- NexGame — `@TheNexGame_bot`
- NexCanal Manager — `@the_big_dipper_bot`
- NexDownloader — `@TheNexDownloader_bot`
- NexGroup Manager — `@DarkNexus01_bot`
- NexStick — `@The_Nexus_techbot`

## Architecture

All five bots run as separate Node.js processes behind one HTTP gateway. They use one MongoDB URI and the same logical database (`nexus_bots`), with bot-specific collection prefixes to avoid collisions. NexGame also uses Redis for fast temporary state and queues.

Cross-promotion is enabled by default after 6 successful interactions, with a 5-day cooldown per user and bot.

## Render deployment

This repository includes `render.yaml` and a root `Dockerfile`.

1. In Render, create a **Blueprint** from this private GitHub repository.
2. Render will detect `render.yaml`.
3. Fill every variable marked `sync: false` in the Render dashboard.
4. Deploy.
5. Check `/health` on the generated Render URL.

Render-generated secrets are used for webhook signing where possible. Never commit a real `.env` file, bot tokens, MongoDB credentials, Redis credentials, Telegram API hash, or payment signing secrets to GitHub.

## Shared database

Set:

- `NEXUS_MONGODB_URI`
- `NEXUS_MONGODB_DB_NAME=nexus_bots`

The five bots will automatically receive the shared MongoDB connection.

## Source bundle

The production source is stored in base64 archive chunks named `nexus-bots-src.tar.gz.b64.part-*`. The Docker build concatenates, decodes, and extracts them before installing dependencies and building the TypeScript bots. This keeps deployment atomic and avoids committing secret `.env` files or generated build folders.
