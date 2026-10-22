# NexAPIs

Clean-room API compatibility service for the public API behaviors catalogued from EliteProTech and other public integrations. No EliteProTech source code is copied and the service does not hardcode or proxy the EliteProTech host.

## Scope

- **59 dashboard-compatible routes** across AI, Image, Tools, Download, Search and Email.
- **11 additional publicly observed legacy/hidden routes** kept for compatibility.
- Total catalog: **70 routes**.
- Common response envelope: `{ "status": true, "result": ... }`.
- GET query parameters and POST JSON bodies are both accepted.
- Provider-specific routes can be wired one by one with environment variables.
- YouTube/general media routes use local `yt-dlp` when available.
- `/countries`, `/money`, `/lyrics`, `/ytsearch`, `/font`, `/tempurl`, `/webcopier` and basic AI/image provider modes already have native implementations or generic provider adapters.
- `/nsfw` and `/deepfake` are intentionally disabled.

## Run

```bash
node src/server.mjs
```

or:

```bash
npm test
npm run check
npm start
```

Default port: `8787`.

## Provider model

Every unimplemented route has a deterministic environment variable derived from its path. Example:

- `/removebg` → `NEXAPIS_PROVIDER_REMOVEBG`
- `/tools/ocr` → `NEXAPIS_PROVIDER_TOOLS_OCR`
- `/search/4kwallpaper` → `NEXAPIS_PROVIDER_SEARCH_4KWALLPAPER`

Set the variable to an endpoint controlled by us (or another approved provider). NexAPIs forwards the same query/body parameters and preserves the public route exposed to our bots.

This lets us replace providers gradually without ever changing the API URLs used by NexDownloader, NexAI, WhatsApp bots, Telegram bots or future Nextech services.

## Important routes

Browse the authoritative machine-readable catalog at `GET /catalog`.

The catalog intentionally preserves historical spelling such as `/fdriod` for client compatibility.
