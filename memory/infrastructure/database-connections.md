# Database connections

## Overview

Postgres is hosted by Supabase and reached through a **connection pooler**.
Which pooler, and how many connections are taken from it, is the decision this
file records — it was measured, not assumed.

```
Nest ──DATABASE_URL──> Supabase session pooler :5432 ──> Postgres
     └─DIRECT_URL────> same endpoint (migrations; tx fallback)
```

## Rules / contracts

- **`DATABASE_URL` points at the SESSION-mode pooler (:5432), not the
  transaction-mode one (:6543).** Measured from the app host: ~270 ms per query
  on :6543 against ~53 ms on :5432, with a 57 ms TCP round-trip to the region —
  so the gap is pgbouncer overhead, not network. Every endpoint issues several
  queries, so a ~5× penalty multiplied straight into page-load time. Session
  mode also makes Prisma's interactive transactions work natively.
- **`connection_limit` must stay well under Supabase's `pool_size: 15`.** It is
  set to 8. Exceeding the project-wide cap fails with *"(EMAXCONNSESSION) max
  clients reached in session mode"*, and the budget must leave room for
  migrations, `psql`, and a second app instance.
- **The second client is conditional, by endpoint not by string.** `DIRECT_URL`
  gets its own `PrismaClient` only when it addresses a *different* host+database
  than `DATABASE_URL`. The two URLs routinely differ only in query params
  (`?connection_limit=…` on one, none on the other), and a raw string compare
  would open a redundant second pool against the same endpoint — doubling the
  connections held against that same cap of 15.
- **Transactions carry the connection implicitly.** `runInTransaction` stores
  the transaction client in an `AsyncLocalStorage`, and `PrismaRepository.prisma`
  resolves to it — so repository methods need no `tx` argument and cannot
  accidentally write outside the transaction.
- **Inside a transaction, writes run sequentially.** An interactive transaction
  is one connection; `Promise.all` over it is unsafe.
- **Keep transactions short.** Each statement is a round-trip, and enough of
  them exceeds Prisma's 5 s interactive-transaction timeout, aborting with
  *"Transaction not found"*. Prefer one `createMany` over N inserts.
- **Background jobs must cap their own concurrency.** With `connection_limit=8`
  shared across the process, a job that fans out unbounded drains the pool and
  starves live requests — background work must never make the app slower for
  someone using it.

## Failure modes worth knowing

- **`PrismaService.client()` is a method, not a getter.** Read through a getter,
  `this` binds to the raw `PrismaClient` target rather than the Proxy, and the
  model delegates vanish — `this.prisma.household` is `undefined`.
- **Transaction-mode poolers break interactive transactions**, because
  statements may hop backend connections mid-transaction. The `DIRECT_URL`
  client exists as the fallback for any environment forced onto :6543.
- **`$transaction` is absent on a transaction client.** Inside a repository, use
  the inherited `this.runInTransaction(...)`: the resolved `this.prisma` may
  already *be* a transaction client, which has no `$transaction` method.
- **No connection is opened under `NODE_ENV=test`,** nor when `DATABASE_URL` is
  unset — unit tests never reach a real database.

## Where it lives in code

- `src/database/prisma/prisma.service.ts` — both clients, the endpoint compare,
  the `AsyncLocalStorage` transaction context.
- `src/common/repositories/prisma.repository.ts` — how `this.prisma` resolves.
- `prisma/schema.prisma` — `directUrl`.
- `.env` — the reasoning is repeated at the top of the file, where it is read.

Related: [[caching]], [[deployment]]
