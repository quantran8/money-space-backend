import { Injectable, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { PrismaService } from '../../database/prisma/prisma.service';
import { CacheService } from './cache.service';
import { cacheKeys } from './cache.keys';

/**
 * Drops a household's cached views after a write.
 *
 * **Transaction-aware.** Invalidating from inside a transaction is a race: the
 * keys would be deleted while the write is still uncommitted, so a concurrent
 * read could miss, re-query, and re-cache the *pre-commit* state — leaving a
 * stale entry behind that no further write would clear. Worse, a rollback would
 * have discarded the write while the cache stayed dropped.
 *
 * So when called inside `runInTransaction`, the household is queued and flushed
 * only once the outermost transaction commits. This mirrors the pattern
 * `PrismaService.isInTransaction()` was written for.
 */
@Injectable()
export class CacheInvalidator {
  private readonly logger = new Logger(CacheInvalidator.name);

  constructor(
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Households queued by an in-progress transaction, scoped to that
   * transaction's async call chain.
   *
   * This is an `AsyncLocalStorage` rather than an instance field because
   * concurrent requests share this singleton: a plain `Set` would let one
   * request's rolled-back transaction leak its households into another
   * request's flush. Each transaction gets its own Set, and it is read back
   * *inside* the same async context that wrote it.
   */
  private readonly pendingContext = new AsyncLocalStorage<Set<string>>();

  /**
   * Invalidate every cached view of `householdId`.
   *
   * Safe to call from anywhere in a write path — inside a transaction it defers
   * to the enclosing `runInTransactionAndInvalidate`, outside one it runs
   * immediately. Never throws: a failed invalidation must not roll back a
   * committed write, and the TTL backstop bounds the damage.
   */
  async invalidateHousehold(householdId: string): Promise<void> {
    if (!this.cache.enabled || !householdId) return;

    const pending = this.pendingContext.getStore();
    if (pending) {
      // A transaction is in flight — defer until it commits.
      pending.add(householdId);
      return;
    }

    await this.flush([householdId]);
  }

  /**
   * Runs `work` in a transaction and invalidates `householdId` once it commits.
   *
   * This is the wrapper write paths should use. It guarantees the ordering that
   * matters — commit first, then drop the cache — and guarantees a rollback
   * leaves the cache untouched, because a throw skips the invalidation entirely.
   *
   * Nested calls join the outer transaction and merely add to its pending set;
   * only the outermost frame flushes, once, after the real commit.
   */
  async runInTransactionAndInvalidate<T>(
    householdId: string,
    work: () => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T> {
    const outer = this.pendingContext.getStore();
    if (outer) {
      // Inner frame: the outermost call owns the flush.
      const value = await this.prisma.runInTransaction(() => work(), options);
      outer.add(householdId);
      return value;
    }

    const pending = new Set<string>([householdId]);

    // The Set must be readable after the transaction resolves, so we hold a
    // direct reference rather than re-reading the store outside the context.
    const result = await this.pendingContext.run(pending, () =>
      this.prisma.runInTransaction(() => work(), options),
    );

    // Reached only on commit — a rollback throws above and skips the flush.
    await this.flush([...pending]);

    return result;
  }

  private async flush(householdIds: string[]) {
    for (const householdId of householdIds) {
      try {
        await this.cache.delByPrefix(cacheKeys.household(householdId));
      } catch (error) {
        // CacheService already fails open; this is belt-and-braces so a write
        // never fails because its cache cleanup did.
        this.logger.warn(
          `Failed to invalidate cache for household ${householdId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
