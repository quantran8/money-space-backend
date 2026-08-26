# Logging

```
NestJS  →  Pino  →  stdout  →  Alloy (on the VM)  →  Grafana Cloud
                                                     ├─ Loki (managed)
                                                     └─ Grafana UI
```

Nothing about logs is stored on the VM. Alloy is the only component deployed
there; retention, the query UI and the storage bill are Grafana Cloud's side.

## What the app writes

[`src/config/logger.config.ts`](../../src/config/logger.config.ts) configures
Pino through `nestjs-pino`. Every existing `new Logger('Context')` call keeps
working — the output is now one JSON object per line instead of Nest's coloured
text, and `NODE_ENV` decides:

| | development | production |
|---|---|---|
| format | pino-pretty, coloured | JSON, one line per record |
| default level | `debug` | `info` |

One request produces **one** completion line, carrying `req.id`, `res.statusCode`
and `responseTime`. `LoggingInterceptor` adds `handler`, `route`, `userId` and a
`payload` *shape* (`items:20/total:143`) to that same line rather than logging
its own — see the file for why the response body is never serialized.

Not logged, on purpose:

- `/health` and `/` — polled every 30s by the container healthcheck and by
  uptime monitors. Add to `SILENT_ROUTES` to silence another such route.
- Credentials, by two independent mechanisms. `censor()` walks every emitted
  record and replaces the value of any `password` / `token` / `secret` /
  `apiKey`-shaped key **at any depth** — pino's own `redact` was not enough,
  its `*` wildcard matches exactly one level. Request headers are covered
  separately: the `req` serializer projects a fixed four-field list, so
  `authorization`, cookies and any header added later never reach the log at
  all. Both are asserted in `src/config/logger.config.spec.ts`.

`x-request-id` is honoured if the caller sends one, generated otherwise, and
always echoed back on the response. Every line of one request shares it.

### Env vars

| Variable | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `debug` dev / `info` prod | `trace`…`fatal`. `debug` in production multiplies ingest — that is the point of the split default. |
| `SERVICE_NAME` | `money-space-backend` | Becomes the `service` field, for when more than one app ships into the same stack. |

## What Alloy ships

[`alloy/config.alloy`](alloy/config.alloy) discovers containers over the Docker
socket, so streams are labelled by **compose service name**, not container id —
a label that would otherwise change on every deploy.

Backend, Caddy and Redis are all collected. Caddy's access log is what separates
"the app returned 502" from "the app was never reached", which the app's own
logs cannot answer. A container opts out with `labels: { logs.exclude: "true" }`
(Alloy itself does, or a failed-push warning would produce a line that fails to
push).

Labels are kept deliberately few — Loki indexes and bills per unique label
combination:

| Label | Source |
|---|---|
| `service_name`, `compose_project` | Docker compose labels |
| `host` | `HOSTNAME_LABEL` |
| `level`, `env` | parsed out of the Pino JSON |
| `collector` | constant `alloy` |

`req_id` and `context` are **structured metadata**, indexed per entry rather
than per stream, so filtering by request id does not create a stream per
request. `responseTime` and `res.statusCode` stay unindexed fields, queried with
`| json` at read time.

Entries survive a Grafana Cloud outage in an on-disk write-ahead log
(`alloy_data` volume) instead of being dropped.

## Setup

### 1. Grafana Cloud

Create a free stack, then open **Home → Connections → Loki → Send logs**. That
one page has all three values:

- the push URL, ending in `/loki/api/v1/push` (region-specific — copy it)
- the **numeric** user/stack id — *not* an email address; an email works against
  the portal and returns 401 from the push endpoint
- an access-policy token with the `logs:write` scope (starts with `glc_`)

Set retention under **Administration → Billing / Data retention**. The free tier
is 50 GB of ingest and 30 days by default; **7 days** is the intended setting
here — it is a stack setting, not something this repo configures.

### 2. GitHub

| Name | Kind | Value |
|---|---|---|
| `ENABLE_OBSERVABILITY` | Variable | `true` to deploy Alloy at all |
| `GRAFANA_CLOUD_LOKI_URL` | Variable | the push URL |
| `GRAFANA_CLOUD_LOKI_USER` | Variable | the numeric id |
| `GRAFANA_CLOUD_LOKI_TOKEN` | **Secret** | the `glc_…` token |
| `HOSTNAME_LABEL` | Variable (optional) | defaults to `money-space-vm` |

The deploy writes them to `.env.alloy` on the VM, separate from the app's
`.env`: Alloy has no business holding the Supabase service-role key.

With `ENABLE_OBSERVABILITY` unset or `false`, the deploy runs exactly as before
and `--remove-orphans` stops any Alloy already running.

### 3. The dashboard

Import [`grafana/dashboards/backend-logs.json`](grafana/dashboards/backend-logs.json)
by hand: **Dashboards → New → Import → paste JSON**, then pick your Loki
datasource when prompted. It is bound to a `${datasource}` variable rather than
a fixed uid precisely so that prompt works.

Deliberately not pushed by the workflow — dashboards edited in the UI would be
overwritten on the next deploy.

Panels: log volume by level, error count, status classes, latency percentiles,
slowest routes, top error messages, and a live tail.

## Querying

```logql
{service_name="backend"} | json                      # everything, parsed
{service_name="backend", level="error"}              # index lookup, not a scan
{service_name="backend"} | req_id = "<uuid>"         # one request end to end
{service_name="backend"} | json | responseTime > 500 # slow requests
{service_name="caddy"}                               # was the app even reached
```

## When logs stop arriving

Alloy's UI lists every component's health and its last error. It binds to
loopback only, so reach it through a tunnel:

```bash
ssh -L 12345:127.0.0.1:12345 <host>   # then open http://localhost:12345
docker compose logs alloy             # or just read its own output
```

The usual causes, in the order they actually occur:

1. `GRAFANA_CLOUD_LOKI_USER` holds an email instead of the numeric id → 401.
2. The token lacks `logs:write`, or belongs to a different stack → 401/403.
3. The push URL is for another region → 404.
4. Ingest limit reached on the free tier → 429. Alloy retries and the WAL holds
   the backlog, so this recovers on its own once the window rolls over.
