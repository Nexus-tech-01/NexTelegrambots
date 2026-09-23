# Secret rotation plan before final VPS cutover

Audit date: 2026-09-23.

The repository history contains evidence that a root `.env` file was previously tracked and later removed. Historical recovery work also explicitly warned that previously committed/used credentials should be treated as potentially compromised.

This document does **not** prove that every variable below was exposed with a real value. It defines the safe rotation plan for any credential that was ever committed, pasted into repository history, or shared outside its intended secret store.

## Do not rotate blindly while production is still running

Several credentials are live dependencies. Rotating them too early can stop bots, NexControl or database access.

Use a controlled sequence:

1. inventory which credentials are currently used by each running service;
2. create replacement credentials where the provider supports overlap;
3. put only the replacement values into Vercel/new VPS secret stores;
4. deploy and verify the new path;
5. invalidate the old credential;
6. verify the old host can no longer use the retired secret;
7. record the rotation date without storing the secret value.

## High-priority credentials

### Telegram Bot API tokens

For every BotFather-managed bot whose token may have appeared in history:

- generate/revoke to obtain a new token;
- update only the intended service environment;
- restart that bot;
- verify commands/webhooks/polling;
- confirm the old token no longer works.

Do this bot-by-bot rather than invalidating the whole fleet at once.

### MongoDB credentials

If a MongoDB URI/password may have been exposed:

- create a new database user/password with only the required database privileges;
- place the new URI in the approved secret stores;
- verify NexControl/NexAccount/bots;
- remove the old database user.

Do not print the URI during checks.

### Redis credentials

If Redis URLs/passwords may have been exposed:

- rotate provider credentials;
- update only services that actually consume that Redis instance;
- verify queues/locks/state;
- revoke the old credential.

### NexControl secrets

Rotate potentially exposed values such as:

- admin password;
- session signing secret;
- fleet/agent keys;
- service-specific control keys.

The new VPS should preferably use a dedicated `NEXCONTROL_AGENT_KEY` instead of reusing a broad fleet/session secret.

### Telegram MTProto application credentials

If the Telegram `api_id/api_hash` pair was genuinely exposed, treat it as sensitive application credential material. Do not put it in Git. If replacement is required, coordinate it with NexAccount/session testing because MTProto client configuration is shared by account runtimes.

### AI/provider API keys

Rotate any OpenAI/Gemini/DeepSeek/OpenRouter/Groq or other provider key that ever entered repository history, logs or screenshots.

### Meta/Facebook credentials

When NexMeta stage 2 is deployed, rotate any exposed:

- Meta App Secret;
- Page access token;
- NexMeta control key;
- token-encryption key;
- signed Nexus bridge key.

Do not use a personal Facebook password as a server secret.

## Secrets that should be distinct

Do not reuse one value for several trust boundaries merely to simplify setup.

Keep distinct:

- NexControl browser/admin authentication;
- NexControl Agent key;
- NexAccount session-encryption key;
- NexAccount local control key;
- Nexus cross-platform bridge HMAC key;
- Meta control key;
- database credentials;
- backup decryption identity.

## Rotation record

Store a non-secret record such as:

```text
credential_class | service | rotated_at | old_revoked | verification
```

Never record the actual token/password/key in the rotation log.

## Acceptance gate

The production migration is not fully closed until credentials known or reasonably suspected to have been committed historically have either been rotated/revoked or explicitly reviewed and documented as non-secret/test-only values.
