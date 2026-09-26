# NexAI private Cobalt

Private loopback-only Cobalt fallback for NexAI social downloads.

- Image: `ghcr.io/imputnet/cobalt:11`
- Bind: `127.0.0.1:9000`
- Container: `nex-cobalt`
- Public exposure: none
- Used only after local `yt-dlp` fails.

Deploy:

```bash
bash infra/cobalt/run.sh
```

The bot uses `http://127.0.0.1:9000/` as its Cobalt endpoint.
