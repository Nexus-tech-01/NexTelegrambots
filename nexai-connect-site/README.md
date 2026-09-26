# NexAI Connect

Standalone Vercel surface for linking a Telegram identity to NexAI.

- Public UI: `/`
- Canonical UI route: `/nexai/connect`
- Pairing API: `/api/nexai/pair/*`
- Health: `/api/nexai/health`

The site never asks for Telegram login codes, SMS codes, or 2FA passwords. Pairing is confirmed inside Telegram through @NexAi01_bot.

Required production environment variable:

- `NEXCONTROL_SESSION_SECRET`
