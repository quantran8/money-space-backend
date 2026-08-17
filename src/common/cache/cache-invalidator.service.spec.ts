import { AsyncLocalStorage } from 'async_hooks';
import { CacheInvalidator } from './cache-invalidator.service';
import type { CacheService } from './cache.service';
import type { PrismaService } from '../../database/prisma/prisma.service';

/**
 * Stand-in for PrismaService's transaction plumbing, reproducing the two
 * behaviours the invalidator relies on: `isInTransaction()` reflects the
 * current async context, and nested `runInTransaction` joins the outer one
 * instead of opening a second.
 */
class FakePrisma {
  private readonly context = new AsyncLocalStorage<object>();
  /** Set by a test to make the "transaction" roll back. */
  failWith: Error | null = null;
  commits = 0;

  isInTransaction() {
    return this.context.getStore() !== undefined;
  }

  client() {
    return this.context.getStore() ?? this;
  }

  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return work(); // nested: join the outer one
    return this.context.run({}, async () => {
      const result = await work();
      if (this.failWith) throw this.failWith; // rollback at commit time
      this.commits += 1;
      return result;
    });
  }
}

describe('CacheInvalidator', () => {
  let cache: { enabled: boolean; delByPrefix: jest.Mock };
  let prisma: FakePrisma;
  let invalidator: CacheInvalidator;

  beforeEach(() => {
    cache = {
      enabled: true,
      delByPrefix: jest.fn().mockResolvedValue(undefined),
    };
    prisma = new FakePrisma();
    invalidator = new CacheInvalidator(
      cache as unknown as CacheService,
      prisma as unknown as PrismaService,
    );
  });

  const prefixesDropped = () =>
    cache.delByPrefix.mock.calls.map((call: string[]) => call[0]);

  it('invalidates immediately when called outside a transaction', async () => {
    await invalidator.invalidateHousehold('hh-1');
    expect(prefixesDropped()).toEqual(['hh:hh-1:']);
  });

  it('does nothing when caching is disabled', async () => {
    cache.enabled = false;
    await invalidator.invalidateHousehold('hh-1');
    expect(cache.delByPrefix).not.toHaveBeenCalled();
  });

  describe('runInTransactionAndInvalidate', () => {
    it('drops the cache only AFTER the transaction commits', async () => {
      const order: string[] = [];
      cache.delByPrefix.mockImplementation(() => {
        order.push('invalidate');
        return Promise.resolve();
      });

      await invalidator.runInTransactionAndInvalidate('hh-1', () => {
        order.push('write');
        return Promise.resolve('done');
      });

      // Invalidating mid-transaction would let a concurrent read re-cache the
      // pre-commit state, so the ordering here is the whole contract.
      expect(order).toEqual(['write', 'invalidate']);
      expect(prisma.commits).toBe(1);
    });

    it('returns the work result untouched', async () => {
      const result = await invalidator.runInTransactionAndInvalidate(
        'hh-1',
        () => Promise.resolve({ id: 'asset-1' }),
      );
      expect(result).toEqual({ id: 'asset-1' });
    });

    it('leaves the cache intact when the transaction rolls back', async () => {
      prisma.failWith = new Error('constraint violation');

      await expect(
        invalidator.runInTransactionAndInvalidate('hh-1', () =>
          Promise.resolve('never committed'),
        ),
      ).rejects.toThrow('constraint violation');

      // The write never landed, so dropping the cache would only cause a
      // pointless re-query — and would mask the rollback.
      expect(cache.delByPrefix).not.toHaveBeenCalled();
    });

    it('flushes once for a nested call, after the outermost commit', async () => {
      const order: string[] = [];
      cache.delByPrefix.mockImplementation((prefix: string) => {
        order.push(`invalidate:${prefix}`);
        return Promise.resolve();
      });

      await invalidator.runInTransactionAndInvalidate('hh-1', async () => {
        order.push('outer-write');
        // e.g. createDebt → createMoneyEvent, both wrapping their own writes.
        await invalidator.runInTransactionAndInvalidate('hh-1', () => {
          order.push('inner-write');
          return Promise.resolve();
        });
        order.push('outer-continues');
      });

      expect(order).toEqual([
        'outer-write',
        'inner-write',
        'outer-continues',
        'invalidate:hh:hh-1:',
      ]);
      expect(cache.delByPrefix).toHaveBeenCalledTimes(1);
    });

    it('flushes every household touched by one transaction', async () => {
      await invalidator.runInTransactionAndInvalidate('hh-1', async () => {
        // A cross-household write, e.g. moving an asset between households.
        await invalidator.invalidateHousehold('hh-2');
      });

      expect(prefixesDropped().sort()).toEqual(['hh:hh-1:', 'hh:hh-2:']);
    });

    it('defers a bare invalidateHousehold called inside a transaction', async () => {
      const order: string[] = [];
      cache.delByPrefix.mockImplementation(() => {
        order.push('invalidate');
        return Promise.resolve();
      });

      await invalidator.runInTransactionAndInvalidate('hh-1', async () => {
        await invalidator.invalidateHousehold('hh-1');
        order.push('still-in-transaction');
      });

      expect(order).toEqual(['still-in-transaction', 'invalidate']);
    });

    it('does not fail the write when invalidation errors', async () => {
      cache.delByPrefix.mockRejectedValue(new Error('redis down'));

      // A committed write must not be reported as failed because its cache
      // cleanup could not run.
      await expect(
        invalidator.runInTransactionAndInvalidate('hh-1', () =>
          Promise.resolve('committed'),
        ),
      ).resolves.toBe('committed');
    });
  });
});
