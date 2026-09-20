# NexMeta Companion

NexMeta Companion links an already-authenticated Facebook or Messenger browser tab to NexMeta without exporting the Facebook password or browser cookies to the server.

## Security model

- Facebook authentication stays inside the browser.
- NexMeta stores only a SHA-256 hash of the Companion device token.
- Pairing codes are one-time and expire automatically.
- The device token is returned only once to the extension and stored in browser extension local storage.
- Commands are limited to the allow-list implemented by NexMeta.
- Navigation is limited to Facebook and Messenger origins.
- A paired device can be revoked at any time from NexControl.
- The public Companion API is transported through HTTPS.

## Supported v0.1 commands

- `ping`
- `get_context`
- `open_url`
- `list_conversations`
- `read_conversation`
- `send_message`

The DOM executor intentionally uses multiple fallbacks because Facebook changes its web UI frequently.

## Install in Chromium

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select the `nexmeta/companion-extension` folder.
5. Open Facebook or Messenger and sign in normally.
6. Generate a pairing code through NexControl using `companion_create_pairing`.
7. Open the NexMeta Companion popup, enter the code and connect.

## Server actions

Create a pairing code:

```json
{
  "action": "companion_create_pairing",
  "label": "My Facebook browser",
  "ttlSeconds": 900
}
```

List devices:

```json
{
  "action": "companion_list_devices"
}
```

Send a test command:

```json
{
  "action": "companion_enqueue",
  "commandType": "get_context"
}
```

Send a Facebook message from the currently paired browser:

```json
{
  "action": "companion_enqueue",
  "commandType": "send_message",
  "payload": {
    "threadUrl": "https://www.facebook.com/messages/t/THREAD_ID",
    "text": "Hello from NexMeta"
  }
}
```

Revoke a browser:

```json
{
  "action": "companion_revoke_device",
  "deviceId": "DEVICE_ID"
}
```

## Important

This Companion is a browser-side automation layer, not an official Meta API. Facebook UI changes may require selector updates. CAPTCHA, login confirmation, 2FA and other security checkpoints remain manual and are never bypassed.
