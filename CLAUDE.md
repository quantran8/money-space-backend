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
  - **Interactive transactions run on the direct connection.** `DATABASE_URL`
    is Supabase's transaction-mode pooler (pgbouncer, :6543), where Prisma
    interactive transactions are unsupported (statements may hop connections →
    *"Transaction not found"*). `PrismaService` therefore opens a second client
    on `DIRECT_URL` (session-mode, :5432) and routes every `$transaction`
    through it, while single-statement queries stay on the pooler. Set
    `DIRECT_URL` in any environment that uses a transaction-mode pooler.
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

Enforced **app-layer** (NestJS guards/interceptors + repository query filters),
**not** Postgres RLS — the project stays DB-portable. Permission model is 2-axis:
role/capability (`HouseholdRole`, with `permissionLevel` as a nullable override →
NULL derives from role) + record sensitivity (`VisibilityLevel`). Do not add
`CREATE POLICY` / RLS.

## Business logic memory

**All business logic (nghiệp vụ) of the app must be documented under `memory/`.** This is the durable source of truth for how the app's domain flows work.

- **Before changing anything that touches business logic**, read the relevant files in `memory/` first to understand the flow and the nghiệp vụ.
- **Whenever a task changes business logic**, update the corresponding file(s) in `memory/` so they stay accurate.
- One concern per file, named clearly (e.g. `asset-valuation.md`, `household-sharing.md`). See [memory/README.md](memory/README.md).

This rule applies to all three repos (`backend`, `frontend-web`, `mobile-app`) — the business logic in `memory/` describes the shared domain, kept consistent across repos.
