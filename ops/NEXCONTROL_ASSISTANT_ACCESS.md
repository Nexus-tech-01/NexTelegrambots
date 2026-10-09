# NexControl · temporary observer access

## What is implemented

The VPS-native control plane can issue temporary observer API keys. It does not
create a ChatGPT connector or remote shell session by itself.

- Operator opens the authenticated `/nexcontrol/` dashboard through HTTPS.
- **Créer une clé temporaire** issues a 6-hour token shown once.
- The gateway stores only the SHA-256 digest, a label, expiry and audit metadata
  in its local SQLite database; never commit plaintext tokens to Git.
- `GET /api/nxc/assistant/status` accepts `Authorization: Bearer <key>` and returns
  sanitized heartbeat ages and a service summary. Other admin APIs continue to
  require an administrator session and do not accept observer tokens.
- Admins may revoke keys from the same panel; revoked/expired keys are rejected.
- Neither raw keys nor session cookies should be sent in ChatGPT messages,
  screenshots or public issues.

## Activation / limitations

The feature runs **only after the verified gateway release is installed on the
actual VPS** and the existing HTTPS routing is repaired. GitHub CI tests run
against a disposable localhost instance and are not proof of production install.

The ChatGPT session must additionally have a connected, authorized provider or
custom integration supporting authenticated requests to that gateway.
No such direct NexControl/VPS provider is currently connected. Issuing a key
on its own **does not connect this chat to the VPS**.

The observer role is intentionally read-only. File changes, service restarts,
bot changes and interactive shell access are not enabled by this mechanism.
Those require a separately audited, explicitly approved permission design.

## Local diagnostics (administrator only)

Existing health check: `http://127.0.0.1:18731/healthz`.

Public URL is only healthy when `https://<configured-domain>/healthz` returns a
JSON document whose `service` is `nexcontrol-vps`. HTTP 200 with an HTML
body (an unrelated site) is not a passing check.

The gateway listens on loopback and should only be exposed with HTTPS,
proper trusted proxy routing, and firewall controls.
