# NexControl Vercel control-plane audit

Audit date: 2026-09-23.

The first VPS cutover keeps NexControl Web / control plane on Vercel and moves only the agent/runtime side to the VPS.

## Current Vercel state

The connected Vercel account contains the production project:

```text
nexcontrol
```

The most recent listed production deployment is in `READY` state.

The 24-hour production runtime error query returned **no runtime error groups**, and the 24-hour warning/error log query returned no matching entries.

This supports keeping Vercel as the control plane during stage 1 instead of moving another major component at the same time as the Telegram runtime.

## Historical errors that still matter

The seven-day Vercel error history shows earlier deployment/configuration problems that must not be forgotten:

- very high-volume `MONGODB_URI or NEXUS_MONGODB_URI missing` errors on older deployments;
- earlier `ADMIN_PASSWORD missing` errors;
- 21 serverless 30-second timeout events, with the latest recorded on 2026-09-21;
- one recorded upstream `ECONNRESET` / fetch failure.

Those historical errors do not appear in the last 24-hour error window, so they are treated as previous incidents rather than proof that the current production deployment is broken.

## Migration implication

For the Teoheberge migration:

1. leave NexControl on Vercel;
2. configure the VPS NexControl Agent with its dedicated key;
3. keep the Agent outbound-only;
4. verify the Agent heartbeat before any Telegram session-bearing workload starts;
5. do not duplicate Vercel environment variables onto the VPS unless a VPS service actually consumes the same value;
6. if Agent heartbeat fails, debug the control plane/network path before starting bots.

## Acceptance gate

Stage 1 is not accepted until:

- the VPS can reach the NexControl HTTPS endpoint;
- NexControl sees the new VPS Agent heartbeat;
- filesystem/check/log/restart operations work through the new Agent;
- the safe systemd restart dispatcher consumes a test request correctly;
- the existing Vercel control plane remains healthy during the test.

