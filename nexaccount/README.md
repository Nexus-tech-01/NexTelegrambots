# NexAccount

NexAccount turns a paired Telegram user account into a personal automation runtime, while **NexAI** remains a normal Telegram bot used for Inline Mode, callbacks and rich menu UI.

## Pairing

NexControl exposes `/nexaccount`. The browser fetches the NexAccount server public key and encrypts the phone/code/2FA payload with RSA-OAEP before it becomes a NexControl Agent job. The Agent job history therefore receives ciphertext, not the Telegram login secret.

After Telegram authentication, the MTProto session string is encrypted with AES-256-GCM before MongoDB storage. The RSA private key used for transient pairing RPC lives only in `.runtime/` on the bot server and is never committed.

## Menu

- `.menu` asks the normal NexAI bot for an inline result and the **user account** sends that result.
- The compact **header only** is a Telegram blockquote; the command list remains outside the quote.
- A category is kept in **one editable Telegram text message** with no page splitting.
- Commands inside categories are native `bot_command` entities, so `/Ping`, `/Menu`, etc. remain blue/clickable.
- Artwork is rendered above the text as a large link preview instead of a media caption, avoiding Telegram's caption-size/layout problems.
- Categories use compact two-column inline rows; Nextech/NexNews/Dark Universe remain URL buttons.
- Custom emoji IDs can come from `NEXAI_EMOJI_*` or from the connected session's own `.menuemoji` configuration.
- `.menuemoji current`, `.menuemoji anime`, `.menuemoji download`, `.menuemoji style_7`, etc. register an emoji from a replied Telegram custom-emoji message for that session only.
- Menu styles are synchronized from THE BIG DIPPER at deploy time. Style 0 is excluded.
- `.style` shows the styles; `.style N` and `/styleN` change the active style.

## Runtime

Saved accounts reconnect automatically after daemon restart. NexAi × Dipper now executes its command engines locally: AI, downloads, group/admin tools, stickers, games, anime and audio processing do not depend on sibling Telegram bots. Telegram-native adapters live inside `nexaccount`.

Long-running actions use an editable progress message instead of going silent. Sticker export produces a `.wastickers` package with WebP validation; static, video-WebP and Telegram TGS/Lottie sources are converted through the local media pipeline before packaging.

The account session is not disguised as an official Telegram client: it is a normal third-party MTProto client and remains subject to Telegram permissions, flood limits and feature restrictions.

## Account isolation and horizontal scaling

NexAccount is account-scoped. `nexaccount_accounts` and `nexaccount_settings` are keyed by the Telegram user ID, so changing a language, style, prefix, auto-reaction, auto-join, welcome/goodbye or AntiLink setting for one account does not modify another account.

For large fleets, runtimes are split across workers:

- `NEXACCOUNT_WORKER_COUNT` is identical on every worker.
- `NEXACCOUNT_WORKER_INDEX` is unique from `0` to `WORKER_COUNT - 1`.
- Worker `0` is the coordinator. It owns NexAI Bot API polling, pairing and analytics refresh.
- Account assignment uses a persistent `runtimeBucket`, so workers query only their own shard.
- MongoDB runtime leases guarantee that one Telegram account can be active on only one worker at a time.
- `NEXACCOUNT_MAX_RUNTIMES_PER_WORKER` prevents a process from exhausting the server by opening every saved MTProto session.
- Workers reconcile their shard periodically and restore newly paired accounts without restarting the whole fleet.
- Pairing state is encrypted and persisted with a TTL, so a process restart does not automatically destroy an in-progress phone/code/2FA flow.
- The local control API requires the shared NexAccount control key for every privileged route; `/health` remains read-only.

With one worker the behavior remains backwards compatible. Large deployments add workers and choose a per-worker capacity appropriate for the available RAM, CPU, file descriptors, network capacity and Telegram rate limits. The architecture removes the single-process requirement; it does not make 188,900 persistent MTProto connections free of infrastructure cost.
