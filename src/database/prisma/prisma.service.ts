import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';

const FALLBACK_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/money_space?schema=public';

/**
 * The transaction-scoped Prisma client Prisma hands to `$transaction`'s
 * callback. It exposes every model delegate but not connection-management
 * methods (`$connect`, `$transaction`, …).
 */
export type PrismaTransactionClient = Prisma.TransactionClient;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly shouldConnect: boolean;

  /**
   * A second client bound to `DIRECT_URL` (a session-mode / direct connection),
   * used ONLY for interactive transactions. `DATABASE_URL` points at Supabase's
   * transaction-mode pooler (pgbouncer, port 6543), on which Prisma interactive
   * transactions are unsupported: statements in one `$transaction` can land on
   * different backend connections, so `tx` gets "Transaction not found". Routing
   * `$transaction` through a session/direct connection is the standard fix while
   * keeping single-statement queries on the pooler. Undefined when no
   * `DIRECT_URL` is set (local/dev/test) — transactions then use the main
   * client, preserving the previous behaviour.
   */
  private readonly txClient?: PrismaClient;

  /**
   * Holds the active transaction client for the current async call chain.
   * When a request runs inside `runInTransaction`, every repository read of
   * `this.prisma` (via `PrismaRepository`) resolves to the transaction client
   * stored here, so all writes join the same transaction automatically —
   * without threading a `tx` argument through every repository method.
   */
  private readonly transactionContext =
    new AsyncLocalStorage<PrismaTransactionClient>();

  constructor() {
    const url = process.env.DATABASE_URL ?? FALLBACK_DATABASE_URL;

    super({
      datasources: {
        db: {
          url,
        },
      },
    });

    this.shouldConnect =
      Boolean(process.env.DATABASE_URL) && process.env.NODE_ENV !== 'test';

    // Only spin up the dedicated transaction client when a direct URL is
    // configured AND it differs from the main URL (otherwise the pooler client
    // already is the session connection, e.g. plain local Postgres).
    const directUrl = process.env.DIRECT_URL;
    if (
      this.shouldConnect &&
      directUrl &&
      directUrl !== process.env.DATABASE_URL
    ) {
      this.txClient = new PrismaClient({
        datasources: { db: { url: directUrl } },
      });
    }
  }

  async onModuleInit() {
    if (!this.shouldConnect) {
      return;
    }

    await this.$connect();
    await this.txClient?.$connect();
  }

  async onModuleDestroy() {
    if (!this.shouldConnect) {
      return;
    }

    await this.$disconnect();
    await this.txClient?.$disconnect();
  }

  /**
   * The client repositories should use for a query. Returns the active
   * transaction client when the caller is inside `runInTransaction`, otherwise
   * the root client (auto-commit, one statement per call).
   *
   * This MUST be a method, not a getter. `PrismaClient` wraps each instance in a
   * Proxy that exposes the model delegates (`.household`, `.debt`, …). When an
   * accessor (getter) is read through that Proxy, `this` inside it binds to the
   * raw target — which has no delegates — so `this` (returned as the fallback)
   * would be a client where `.household` is `undefined`. Called as a method,
   * `this` binds to the Proxy, so `this.household.findMany(...)` works. See the
   * getter-vs-method binding difference under Prisma's proxy.
   */
  client(): PrismaTransactionClient | this {
    return this.transactionContext.getStore() ?? this;
  }

  /**
   * Run `work` inside a single database transaction. Every repository call made
   * (directly or transitively) within `work` runs against the same transaction
   * client, so the whole unit either commits together or rolls back together.
   *
   * Nested calls reuse the outer transaction (Prisma does not support real
   * nested transactions) so an inner `runInTransaction` never opens a second
   * one.
   */
  async runInTransaction<T>(
    work: (tx: PrismaTransactionClient) => Promise<T>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    },
  ): Promise<T> {
    const existing = this.transactionContext.getStore();
    if (existing) {
      // Already inside a transaction — join it rather than nesting.
      return work(existing);
    }

    // Run the interactive transaction on the direct/session connection when one
    // is configured (see `txClient`); fall back to the main client otherwise.
    const runner = this.txClient ?? this;
    return runner.$transaction(
      (tx) => this.transactionContext.run(tx, () => work(tx)),
      options,
    );
  }
}
