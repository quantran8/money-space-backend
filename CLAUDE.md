# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The backend for Money Space — a Vietnamese-first family/household finance app. NestJS 11 + Prisma 6 (Postgres) + Supabase. Source lives in [src/](src/) (`modules/`, `common/`, `config/`, `database/`); the Prisma schema is in [prisma/](prisma/) and Supabase migrations in [supabase/](supabase/).

## Commands

```bash
npm run start:dev        # nest start --watch
npm run build            # nest build
npm run lint             # eslint --fix
npm run test             # jest
npm run prisma:generate  # regenerate the Prisma client
npm run db:init          # scripts/init-db.sh
```

## API versioning

Every route is served under **`/api/v1/*`**. The prefix and the version are set
once in [src/main.ts](src/main.ts) via `setGlobalPrefix('api')` +
`enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })` — a
`@Controller` declares only its own path (`'households/:householdId/debts'`),
never `api/` or a version.

- **Adding an endpoint**: nothing to do. `defaultVersion: '1'` puts it on v1.
- **Introducing v2**: put `@Version('2')` on the individual route or controller
  that changed. Everything else stays on v1 — versioning is a per-route opt-in,
  not a repo-wide migration.
- **`/` and `/health` are `VERSION_NEUTRAL`** and excluded from the prefix. The
  container healthcheck in [deploy/docker-compose.prod.yml](deploy/docker-compose.prod.yml)
  hits `/health` directly, so it must not move when the API version changes.
  Note `exclude` alone is not enough — it strips the prefix but still applies
  the version, which would yield `/v1/health`.
- **Frontend**: repositories pass version-free paths and `API_PREFIX` in
  `packages/core/src/shared/api/http.ts` applies `/api/v1`. Keep it that way so
  the version stays a one-line change on both sides.

## Caching (Redis)

Optional and **fail-open**: with `REDIS_URL` unset no client is built and every
read goes straight to Postgres, so local dev, CI, and tests need no Redis. When
Redis is configured but unreachable, `CacheService` logs once and reports a miss
— an outage costs latency, never correctness, and never a 500.

- **Cached today**: the dashboard, the forecast, and market data.
  - **Dashboard** (`GET .../dashboard`) fans out to ten parallel queries.
    `assertHousehold` runs **outside** the cached region — a cache hit must
    never let a caller skip the existence/authorization check.
  - **Forecast** is cached at `ForecastService.forecast()`, the chokepoint that
    `forecast`, `flexible-money`, `financial-state`, `forecast-bundle` and
    `goalProjection` all funnel through; `flexibleMoney`/`financialState` are
    pure functions of its result, so one key covers all five endpoints. Keyed by
    `horizon_days`, which `parseHorizon` restricts to `[7, 30, 60, 90]` — a
    bounded key space. An explicit `asOfDate` (snapshot backfill only; no
    controller passes one) bypasses the cache entirely.
  - **`POST /what-if` is not cached and must not invalidate.** It needs the raw
    bundle to re-run the engine over a hypothetical event, and it writes
    nothing — it is a POST only because it needs a body. It carries
    `@NoCacheInvalidation()`; without it, tuning an amount would flush a valid
    cache on every run. Use that decorator for any other write-shaped read.
  - **Market data** (`market:*`) is the one cached region that is deliberately
    **not** per-household. **Every** read endpoint on `MarketDataController` is
    cache-backed — prices, symbols, gold, FX counter rates and the persisted
    fx-rates list — and `market-data.controller.spec.ts` asserts it, so a new
    endpoint that forgets to cache fails the build: quotes and symbol
    listings are global and identical for everyone. Keeping them outside the
    `hh:` prefix is what stops `CacheInvalidationInterceptor` from dropping them
    after every household write — editing an asset has not changed what BTC is
    worth. Provider calls are metered, so that would cost real credits.
- **Build keys only in [src/common/cache/cache.keys.ts](src/common/cache/cache.keys.ts).**
  Every per-household entry must live under the `hh:<id>:` prefix so one
  `delByPrefix` drops all of them. A key built ad-hoc in a service silently
  survives invalidation and serves stale money figures.
- **Invalidation is automatic.** `CacheInvalidationInterceptor` (global) drops
  the household's keys after any successful `POST/PUT/PATCH/DELETE` carrying a
  `:householdId` route param. This is deliberately *not* wired into the ~25
  individual write sites — a new endpoint is covered the moment it is
  registered, and there is no hook to forget. TTL (`cacheTtl.household`) is only
  a backstop.
- **Never invalidate from inside a transaction.** Dropping keys before commit
  lets a concurrent read re-cache the *pre-commit* state, leaving a stale entry
  no later write clears; a rollback would also discard the write while the cache
  stayed dropped. Use `CacheInvalidator.runInTransactionAndInvalidate(...)`,
  which flushes only after the outermost transaction commits (and skips
  entirely on rollback). A bare `invalidateHousehold` called inside a
  transaction defers automatically.
- **Anything cached must be JSON round-trippable** — `undefined`, `Date`, and
  `Decimal` do not survive. The dashboard already returns plain numbers/strings.

## Scheduled jobs

`ScheduleModule.forRoot()` is registered in `AppModule`. One job today:
`AssetsValuationCron` (23:45 Asia/Ho_Chi_Minh) captures every market asset's
end-of-day value, so history holds settled days while today stays live — see
`memory/market-data.md`. It is the only writer of that series; nothing
re-prices per page visit.

Two rules any new job must follow, both learned from that one:

- **Cap concurrency.** `DATABASE_URL` carries `connection_limit=8` against a
  project-wide `pool_size: 15`. A job that fans out unbounded drains the pool
  and starves live requests — background work must never make the app slower
  for someone using it.
- **Guard against overlap.** A tick that starts while the previous one is still
  running doubles that pressure. Keep an in-process `running` flag.

Every instance runs its own scheduler, so a job that must execute exactly once
needs an env switch (`MARKET_VALUATION_CRON_ENABLED=false`) or an external
scheduler hitting the equivalent endpoint.

## Data-writing conventions

Two cross-cutting rules for any create/update/delete flow:

- **Atomicity — wrap multi-table writes in a transaction.** Any operation that
  writes to more than one table (or issues more than one write statement) must
  either fully succeed or fully roll back. Wrap the writes in
  `PrismaService.runInTransaction(async () => { … })` (inject `PrismaService`
  into the service). Every repository call inside that callback automatically
  joins the transaction — `PrismaRepository.prisma` resolves to the active
  transaction client via `AsyncLocalStorage`, so repo methods need no `tx`
  argument. Nested `runInTransaction` calls reuse the outer transaction.
  - Inside a transaction, **run writes sequentially** (`await` one after
    another), never `Promise.all` — an interactive transaction is one
    connection and concurrent statements on it are unsafe.
  - Inside a repository, use the inherited `this.runInTransaction(...)` helper
    instead of `this.prisma.$transaction(...)` (the resolved `this.prisma` may
    already be a transaction client, which has no `$transaction`).
  - **Keep transactions short.** Each statement is a DB round-trip; too many
    sequential round-trips can exceed the interactive-transaction timeout
    (Prisma default 5s) and abort with *"Transaction not found"*. Prefer a
    single bulk write (`createMany`) over N single-row inserts, and pass a
    larger `{ timeout }` to `runInTransaction` for legitimately heavy units.
  - **`DATABASE_URL` points at the SESSION-mode pooler (:5432), not the
    transaction-mode one (:6543).** The transaction pooler was measured at
    ~270ms per query against ~53ms on :5432 from the same machine (TCP RTT to
    the region is 57ms — so the gap is pgbouncer overhead, not network). Every
    endpoint issues several queries, so that ~5x penalty multiplied straight
    into page-load time. Session mode also makes Prisma's interactive
    transactions work natively.
    - Session mode is capped project-wide at `pool_size: 15`, so `DATABASE_URL`
      carries an explicit `connection_limit` (8) — exceeding the cap fails with
      *"(EMAXCONNSESSION) max clients reached in session mode"*. Budget for
      migrations, psql, and any second app instance.
    - `PrismaService` still opens a second client on `DIRECT_URL` and routes
      every `$transaction` through it **when `DATABASE_URL` addresses a
      different endpoint** — the fallback for environments that must run on a
      transaction-mode pooler, where interactive transactions are unsupported
      (statements may hop connections → *"Transaction not found"*). The two
      URLs are compared by host + database, not raw string, so differing query
      params don't open a redundant second pool.
  - **`PrismaService.client()` is a method, not a getter.** Read through a
    getter, `this` binds to the raw `PrismaClient` target (no model delegates)
    → `this.prisma.household` is `undefined`. As a method, `this` is the Proxy
    and the delegates resolve. Repos call `this.prismaService.client()`.

- **Never leak a raw 500.** The global `HttpExceptionFilter` (registered via
  `APP_FILTER`) catches every exception **thrown inside a request** — including
  rejected promises you `await` — so services never need their own `try/catch`
  to avoid crashing; NestJS wraps every handler and routes errors to the filter.
  For unexpected 5xx (non-`HttpException`, e.g. a raw Prisma error) it returns
  the real message in dev and a generic `"Internal server error"` when
  `NODE_ENV === 'production'`, while always logging the full message + stack.

- **Process-level guard.** `main.ts` registers `unhandledRejection` /
  `uncaughtException` handlers as a safety net for errors the filter can't see —
  fire-and-forget promises (a forgotten `await`), timers, background tasks. They
  log the full stack but do **not** exit the process. (Still: always `await`
  repository calls — a missing `await` bypasses the request filter entirely.)

## Soft-delete convention

- **Which tables soft-delete**: most domain tables carry `deletedAt` and every
  read filters `deletedAt: null`. Exceptions by design: `profiles` and
  `audit_logs` (identity / append-only — never soft-deleted);
  `snapshot_asset_values` (child of an immutable snapshot); `attention_items`
  (its `status = dismissed` IS the "gone" state — do NOT add `deletedAt`).
- **One disappearance mechanism per row**: use `deletedAt` OR a terminal
  `status`, never both.
- **Filtering is still manual** (`where: { deletedAt: null }`) — a follow-up is
  to add a Prisma Client Extension to auto-filter soft-deleted rows so a
  forgotten filter can't leak deleted data. Until then, always include it.

## Authorization

Enforced **app-layer** (NestJS guards + repository query filters), **not**
Postgres RLS — the project stays DB-portable. Do not add `CREATE POLICY` / RLS.

**Membership IS the content permission.** Any live member of a household may
read and write anything in it, including any record's sharing level. There is no
role and no permission tier: `HouseholdRole` and `PermissionLevel` were both
dropped. What makes a change accountable is the journal entry it leaves, not a
permission granted beforehand — see `memory/activity-log.md`.

The single exception is `@RequireHouseholdCreator()`, resolved from
`households.created_by`, guarding exactly three lifecycle operations: delete the
household, remove a member, invite a member. `req.membership` is
`{ householdId, userId, isCreator }` and carries nothing else.

`VisibilityLevel` (`detail | summary_only`) is **presentation, not
authorization**. Nothing is ever excluded from a shared figure because of it, and
the server does not redact — any member can flip a record to `detail` in one
edit, so redaction would be theatre. See `memory/sharing-levels.md`.

Do not reintroduce a role column, a permission enum, or a per-record exclusion
rule. Each existed here before, none was ever wired to anything that worked, and
the exclusion rule left the dashboard and the forecast disagreeing about how much
money the household had.

`assets.counts_as_flexible` is **not** an exception to that: it is the
household's own answer to "is this money spendable", not a permission, and it is
materialized into `assets.liquidity` — the single column every consumer already
reads. The banned shape is a rule only one consumer knows about. Any future
"exclude this record from a figure" feature must land in the shared, stored
value the same way. See `memory/assets.md`.

## Comment style

**Keep code comments short.** Business logic (nghiệp vụ) rationale — why a rule
exists, trade-offs weighed, alternatives rejected, the measured numbers behind a
decision — belongs in `memory/`, not inline. A long explanatory comment
duplicates the doc, drifts out of sync with it, and buries the code.

In code, say *what* a line does, or give a one-line caveat when something is
genuinely surprising, and point at the memory file for the reasoning. When a
change needs a paragraph of justification, that paragraph is a `memory/` edit.

## Business logic memory

**All business logic (nghiệp vụ) of the app must be documented under `memory/`.** This is the durable source of truth for how the app's domain flows work.

- **Before changing anything that touches business logic**, read the relevant files in `memory/` first to understand the flow and the nghiệp vụ.
- **Whenever a task changes business logic**, update the corresponding file(s) in `memory/` so they stay accurate.
- One concern per file, named clearly (e.g. `asset-valuation.md`, `household-sharing.md`). See [memory/README.md](memory/README.md).

This rule applies to all three repos (`backend`, `frontend-web`, `mobile-app`) — the business logic in `memory/` describes the shared domain, kept consistent across repos.
