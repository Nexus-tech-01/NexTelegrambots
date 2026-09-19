# NexAccount

NexAccount turns a paired Telegram user account into a personal automation runtime, while **NexAI** remains a normal Telegram bot used for Inline Mode, callbacks and rich menu UI.

## Pairing

NexControl exposes `/nexaccount`. The browser fetches the NexAccount server public key and encrypts the phone/code/2FA payload with RSA-OAEP before it becomes a NexControl Agent job. The Agent job history therefore receives ciphertext, not the Telegram login secret.

After Telegram authentication, the MTProto session string is encrypted with AES-256-GCM before MongoDB storage. The RSA private key used for transient pairing RPC lives only in `.runtime/` on the bot server and is never committed.

## Menu

- `.menu` asks the normal NexAI bot for an inline result and the **user account** sends that result.
- The entire menu text/caption is one Telegram `expandable_blockquote`.
- Commands inside category pages are native `bot_command` entities, so they render blue/clickable.
- Categories are colored inline buttons (primary) and external Nextech/NexNews/Dark Universe buttons are URL buttons.
- Custom emoji button icons are read from `NEXAI_EMOJI_*`.
- Menu styles are synchronized from THE BIG DIPPER at deploy time. Style 0 is excluded.
- `.style` shows the styles; `.style N` and `/styleN` change the active style.

## Runtime

Saved accounts reconnect automatically after daemon restart. The current foundation includes command detection, Premium capability gating, configured auto-join, configured auto-react, AntiLink, and proxy adapters for NexDownloader/NexStick/NexGame. Telegram-native adapters continue to live in `runtime.mjs`.

The account session is not disguised as an official Telegram client: it is a normal third-party MTProto client and remains subject to Telegram permissions, flood limits and feature restrictions.
