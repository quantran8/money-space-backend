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
  }

  async onModuleInit() {
    if (!this.shouldConnect) {
      return;
    }

    await this.$connect();
  }

  async onModuleDestroy() {
    if (!this.shouldConnect) {
      return;
    }

    await this.$disconnect();
  }

  /**
   * The client repositories should use for a query. Returns the active
   * transaction client when the caller is inside `runInTransaction`, otherwise
   * the root client (auto-commit, one statement per call).
   */
  get client(): PrismaTransactionClient | this {
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

    return this.$transaction(
      (tx) => this.transactionContext.run(tx, () => work(tx)),
      options,
    );
  }
}
