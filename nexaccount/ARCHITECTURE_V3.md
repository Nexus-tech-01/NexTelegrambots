# NexAI / NexAccount Architecture v3

## Goal

NexAccount owns Telegram multi-session orchestration. NexAI owns command intelligence and feature engines. They are connected, but neither should duplicate the other's responsibility.

## Boundaries

### NexAccount
- pairing and MTProto session lifecycle
- encrypted session persistence
- sharding, leases and worker ownership
- reconnect / catch-up / polling
- event ingestion and account identity
- per-account settings and permissions
- dispatching parsed commands to NexAI engines

### NexAI
- command catalog and aliases
- AI engine
- download engine
- anime engine
- sticker engine
- game engine
- group compatibility engine
- media / menu behavior

### Inline bot
- presentation layer only
- menus, callbacks and inline responses
- never the source of truth for session ownership

## Invariants

1. One Telegram account session is owned by at most one active worker lease.
2. A command event is executed at most once per account/message identity.
3. Engine modules never select another user's session.
4. The runtime orchestrator does not contain engine-specific routing branches.
5. A failed engine returns an isolated error and must not kill the account runtime.
6. Pairing state and runtime state remain separate.
7. Secrets and StringSession values never appear in logs or public API responses.

## Flow

Telegram update
-> NexAccount session runtime
-> command parser / deduper
-> permission + context checks
-> NexAI engine router
-> selected local engine
-> response through the same account session

## Migration

v3 keeps all current public commands and aliases. The refactor is internal: existing users should not need to reconnect or learn new commands.
