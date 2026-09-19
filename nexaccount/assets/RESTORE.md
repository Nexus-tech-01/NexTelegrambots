# NexAI creator asset recovery

The live binary asset is backed up as `creator.jpg.b64`.

Restore it with:

```bash
base64 -d creator.jpg.b64 > creator.jpg
```

Expected SHA-256:

```
ca7fe63f4a462051cdb263d26a9e6f9acfd14217678d74097f5e5360337bcf35
```

This asset is the fixed image used by the NexAI creator/about/founder/ceo card regardless of the active visual style.
