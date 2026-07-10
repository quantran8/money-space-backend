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

## Business logic memory

**All business logic (nghiệp vụ) of the app must be documented under `memory/`.** This is the durable source of truth for how the app's domain flows work.

- **Before changing anything that touches business logic**, read the relevant files in `memory/` first to understand the flow and the nghiệp vụ.
- **Whenever a task changes business logic**, update the corresponding file(s) in `memory/` so they stay accurate.
- One concern per file, named clearly (e.g. `asset-valuation.md`, `household-sharing.md`). See [memory/README.md](memory/README.md).

This rule applies to all three repos (`backend`, `frontend-web`, `mobile-app`) — the business logic in `memory/` describes the shared domain, kept consistent across repos.
