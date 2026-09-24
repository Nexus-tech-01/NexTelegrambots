# NexForge Vercel Frontend

Vercel-facing proxy for NexForge Servers / Host Root.

- Vercel serves the public web URL.
- Supabase remains the private application backend and control plane.
- The proxy preserves NexControl session cookies and forces HTML responses to render as HTML.
- No VPS password, Supabase service-role key, or permanent infrastructure secret is stored in this frontend.

Recommended Vercel project root directory: `nexforge-vercel`.
