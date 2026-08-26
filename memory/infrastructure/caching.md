# Caching

## Overview

A Redis layer in front of the most expensive reads. It is an **optimisation and
never a source of truth**: with `REDIS_URL` unset no client is built at all and
every read goes straight to Postgres, exactly as before the cache existed. Local
dev, CI and tests therefore need no Redis.

## Rules / contracts

- **Fail-open, without exception.** Every method swallows Redis errors: `get`
  reports a miss, `set`/`del` become no-ops, and the caller falls through to
  Postgres. An outage costs latency, never correctness, and never a 500.
  - `maxRetriesPerRequest: 1` and `enableOfflineQueue: false` are part of that
    contract — a queued command would block the request past any useful
    deadline, turning a cache outage into an app outage.
  - The `'error'` listener is **load-bearing**: without one, ioredis emits an
    unhandled `'error'` event and crashes the process — the exact opposite of
    failing open.
  - A slow cache must never be slower than the query it replaces, hence
    `CACHE_TIMEOUT_MS` (250 ms) on every round-trip.
- **Degradation is logged once per outage, not per operation.** A flapping Redis
  would otherwise produce a log line per request — see [[logging]].
- **Every key is built in `cache.keys.ts`.** A key built ad-hoc in a service
  silently survives invalidation and serves stale money figures.
- **Per-household entries live under `hh:<id>:`,** so one `delByPrefix` drops
  all of them.
- **Market data is deliberately NOT under `hh:`.** Quotes and symbol listings
  are global and identical for everyone; keeping them outside that prefix is
  what stops the per-household invalidation from dropping them after every
  write. Editing an asset has not changed what BTC is worth, and provider calls
  are metered — so that would cost real credits.
- **Invalidation is automatic, never per-write.** A global interceptor drops the
  household's keys after any successful `POST/PUT/PATCH/DELETE` carrying a
  `:householdId` route param. This is deliberately *not* wired into the ~25
  individual write sites: a new endpoint is covered the moment it is registered,
  and there is no hook to forget. TTL is only a backstop.
- **Never invalidate from inside a transaction.** Dropping keys before commit
  lets a concurrent read re-cache the *pre-commit* state, leaving a stale entry
  no later write clears; a rollback would discard the write while the cache
  stayed dropped. `runInTransactionAndInvalidate` flushes only after the
  outermost transaction commits, and skips entirely on rollback.
- **Authorization runs outside the cached region.** `assertHousehold` is called
  before the cache is consulted — a cache hit must never let a caller skip the
  existence/membership check.
- **Anything cached must be JSON round-trippable.** `undefined`, `Date` and
  `Decimal` do not survive.

## TTLs, and why they differ

| Region | TTL | Reasoning |
| --- | --- | --- |
| household views | 300 s | Explicitly invalidated on write; the TTL is only a backstop against a missed invalidation. |
| market prices | 300 s | Live data driving what a user is told their money is worth. |
| symbol reference lists | 24 h | Large, near-static listings; re-fetching costs provider credits without changing the answer. |
| gold / FX counter rates | 300 s | Dealers republish a few times a day, banks move intraday. |
| persisted FX rates | 900 s | Written by a daily refresh, so re-querying Postgres per request buys nothing. |

## Notes

- **In-process miss deduplication** collapses concurrent misses for the same key
  into one query — ten simultaneous dashboard requests issue one database query,
  not ten. This is the stampede protection that matters on a cold key, and it
  works even with Redis down.
- **`REDIS_KEY_PREFIX`** namespaces the app inside a shared Redis, so clearing
  this app's keys never means `FLUSHDB`.
- **Redis persistence is off** (`--save ""`). A cache surviving restarts would
  just serve staler data than a cold start; every entry is rebuildable from
  Postgres, which is also why `allkeys-lru` eviction is safe.

## Where it lives in code

- `src/common/cache/cache.service.ts` — the fail-open client and dedup.
- `src/common/cache/cache.keys.ts` — every key and TTL.
- `src/common/cache/cache-invalidator.service.ts`,
  `src/common/interceptors/cache-invalidation.interceptor.ts` — invalidation.
- `src/config/cache.config.ts` — env-driven configuration.

Related: [[database-connections]], [[deployment]]
