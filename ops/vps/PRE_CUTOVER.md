# VPS pre-cutover gate

After the new Teoheberge VPS is provisioned, run the non-destructive gate before moving Telegram sessions:

```sh
sudo bash /opt/nex/current/ops/vps/pre-cutover.sh
```

It checks:

- the Git checkout and working-tree state;
- host prerequisites and directory layout;
- repository migration audit hard failures;
- NexControl Agent authentication configuration;
- required NexAccount MTProto/session-encryption configuration;
- MongoDB URI presence without printing it;
- planned worker count;
- installed/active restart dispatcher;
- NexControl Agent service state;
- whether NexAccount workers are already active;
- NexControl Agent JSON validity;
- outbound HTTPS reachability to Telegram and the NexControl control plane.

It does **not** start NexAccount, copy sessions, rotate secrets, or stop the old server.

A green result means the **new host baseline** is ready for the controlled cutover procedure. It does not mean the same MTProto session may be run on both hosts.
