# NexAI Connect V2

Standalone frontend for connecting an existing Telegram account to NexAI.

Flow:
1. Phone number.
2. Telegram verification code.
3. Telegram 2FA password only when 2FA is enabled on the account.
4. Connected-account confirmation.

Security:
- the browser fetches NexAccount's RSA public key from the existing `nexai-connect` control-plane function;
- verification codes and 2FA passwords are encrypted with RSA-OAEP before they leave the browser;
- the frontend sends only the encrypted envelope to the existing secure pairing gateway;
- no Telegram API credentials or NexControl/Vercel secrets are stored in this frontend;
- strict response security headers are configured in `vercel.json`.

Vercel settings:
- Project name: `nexai-connect-v2`
- Root directory: `nexai-connect-v2`
- No environment variables are required for this frontend.
