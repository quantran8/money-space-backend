# Logging

## Overview

Structured logs, shipped off the machine that produces them.

```
NestJS → Pino (JSON on stdout) → Alloy (on the VM) → Grafana Cloud
                                                     ├─ Loki (managed)
                                                     └─ Grafana UI
```

Retention is **7 days**, set on the Grafana Cloud stack — not in any file in
this repo. Nothing about logs is stored on the VM beyond Alloy's write-ahead
buffer.

## Why this shape

**Why ship at all.** Before this, reading production logs meant
`docker compose logs backend` over SSH (the `Fetch backend logs` workflow
automates exactly that). That is fine for "what happened just now" and useless
for "how often has this happened this week" — a container restart discards the
history, and there is no way to correlate a user's report with a request.

**Why not self-host Loki + Grafana.** The first cut ran all three containers on
the VM. On a 1 GB E2.1.Micro the pair needed more RAM than the app itself, and a
log store that OOM-kills the service it observes is worse than no log store.
Only Alloy stays local; it is capped at 256 MB and idles well under 100 MB.

**Why Alloy and not the Docker Loki plugin.** Alloy discovers containers over
the Docker socket, so a stream is labelled by compose *service name*. The
alternative labels by container id, which changes on every deploy and makes a
query span two streams across a release.

## Rules / contracts

- **One line per request.** `pino-http` writes the completion line;
  `LoggingInterceptor` only *enriches* it via `req.log.setBindings`. Three lines
  per request was the earlier shape and tripled ingest for no new information.
- **Response bodies are described by shape, never serialized.** A snapshots
  payload is up to 365 snapshots × their per-asset lines. Walking and
  stringifying that runs synchronously on the event loop while every other
  in-flight request waits, and stores megabytes nobody queries.
- **Redaction is defence in depth**, because each half misses what the other
  catches:
  - `censor()` walks every emitted record and replaces the value of any
    credential-shaped key **at any depth**.
  - the `req` serializer projects a fixed four-field list, so headers never
    reach the log at all — a header added upstream cannot leak by default.
- **4xx is `warn`, 5xx is `error`.** A client sending a bad request is not an
  incident; mixing the two makes alerting on `level="error"` meaningless.
- **`/health` and `/` are never logged.** Both are polled every 30s by the
  container healthcheck and by uptime monitors.
- **Labels stay low-cardinality.** Loki indexes and bills per unique label
  combination. `level` and `env` are labels (bounded sets); `req_id` is
  *structured metadata* (indexed per entry, so filtering by it does not create
  a stream per request); `responseTime` and `statusCode` stay unindexed fields.

## Failure modes worth knowing

- **`nestjs-pino`'s default `forRoutes` mounts nothing under Nest 11.** The
  default is `{ path: '*', method: ALL }`, an object form Nest 11 drops
  silently. Symptom: bootstrap lines and exception-filter lines appear, no
  request line ever does, and no `x-request-id` header comes back — which reads
  like a pino filter problem rather than a routing one. Fix: `forRoutes: ['*']`,
  the string form `AuthMiddleware` already used. Guarded by a test.
- **`formatters.log` runs BEFORE the serializers.** `req`/`res` arrive as live
  Node objects, so a recursive redactor that rebuilds objects from
  `Object.entries()` drops prototype accessors — `res.statusCode` became `null`
  on every line. `censor()` therefore only rebuilds plain objects.
- **pino's `redact` wildcard matches exactly one level.** `*.token` covers
  `{a:{token}}` and silently misses `{a:{b:{token}}}` — the shape a nested DTO
  or an upstream error payload actually arrives in. That is why the recursive
  walk exists rather than a longer `redact` path list.
- **`GRAFANA_CLOUD_LOKI_USER` is the numeric stack id, not an email.** An email
  authenticates against the portal and returns 401 from the push endpoint, with
  no other symptom.

## Where it lives in code

- `src/config/logger.config.ts` — the whole Pino configuration, including
  `censor()`, `SENSITIVE_KEYS` and `SILENT_ROUTES`.
- `src/config/logger.config.spec.ts` — asserts redaction, route silencing, level
  mapping, and the `forRoutes` regression above.
- `src/common/interceptors/logging.interceptor.ts` — enrichment only.
- `deploy/observability/` — Alloy config, the compose file that runs it, the
  dashboard JSON, and the setup README.
- `.github/workflows/deploy.yml` — gated on the `ENABLE_OBSERVABILITY` variable;
  writes `.env.alloy` on the VM.

Related: [[deployment]]
