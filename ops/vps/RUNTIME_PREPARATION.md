# Directly-versioned runtime preparation

Before any NexAccount worker is started on a fresh VPS, install its dependencies from the committed lockfile and run the local regression suite:

```sh
sudo -u nex bash /opt/nex/current/ops/vps/prepare-runtime.sh
```

The script:

- requires Node.js 22+;
- refuses to install without `nexaccount/package-lock.json`;
- verifies `package.json` and `package-lock.json` package versions agree;
- runs `npm ci --omit=dev --no-audit --no-fund`;
- runs the existing NexAccount `npm run check` suite;
- validates NexControl Agent/watchdog Node syntax;
- does **not** start any service or Telegram session.

The existing NexAccount check suite is suitable for this preparation phase because its sharding/media tests are local and the registry check inspects local command/engine routing. It does not need to authenticate Telegram accounts or connect to the production MongoDB merely to perform these checks.

This preparation only covers source that is directly versioned in Git. It intentionally does not install dependencies for the old five-bot fleet until that source is recovered and normalized.
