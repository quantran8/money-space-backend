import { CacheService } from './cache.service';

/**
 * Minimal in-memory stand-in for the ioredis surface CacheService uses. Each
 * method can be made to reject, which is how the fail-open contract is tested.
 */
class FakeRedis {
  /** Keys as Redis actually stores them: with `keyPrefix` already applied. */
  store = new Map<string, string>();
  failWith: Error | null = null;

  /**
   * Mirrors the ioredis `keyPrefix` behaviour the service depends on: key
   * *arguments* are transparently prefixed, but the SCAN `MATCH` pattern is
   * not, and SCAN returns fully-prefixed keys. Getting this asymmetry right in
   * the fake is the whole point — it is exactly what `delByPrefix` compensates
   * for.
   */
  private readonly keyPrefix = 'money-space:';

  get = jest.fn((key: string) =>
    this.guard(this.store.get(this.keyPrefix + key) ?? null),
  );
  set = jest.fn((key: string, value: string) => {
    this.store.set(this.keyPrefix + key, value);
    return this.guard('OK');
  });
  del = jest.fn((...keys: string[]) => {
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(this.keyPrefix + key)) removed += 1;
    }
    return this.guard(removed);
  });
  scan = jest.fn((_cursor: string, _m: string, pattern: string) => {
    // Pattern arrives already prefixed by the caller and is NOT re-prefixed.
    const prefix = pattern.replace(/\*$/, '');
    const found = [...this.store.keys()].filter((key) =>
      key.startsWith(prefix),
    );
    return this.guard(['0', found] as [string, string[]]);
  });
  on = jest.fn();
  quit = jest.fn(() => Promise.resolve('OK'));
  disconnect = jest.fn();

  private guard<T>(value: T): Promise<T> {
    return this.failWith
      ? Promise.reject(this.failWith)
      : Promise.resolve(value);
  }
}

describe('CacheService', () => {
  let redis: FakeRedis;
  let cache: CacheService;

  /**
   * `onModuleInit` refuses to build a client under NODE_ENV=test (by design, so
   * unit tests never reach a real Redis), so the fake is injected directly.
   */
  function makeCache() {
    const service = new CacheService();
    redis = new FakeRedis();
    (service as unknown as { client: unknown }).client = redis;
    return service;
  }

  beforeEach(() => {
    cache = makeCache();
  });

  describe('when Redis is healthy', () => {
    it('calls the loader once on a miss, then serves from cache', async () => {
      const loader = jest.fn().mockResolvedValue({ total: 42 });

      const first = await cache.wrap('k', loader);
      const second = await cache.wrap('k', loader);

      expect(first).toEqual({ total: 42 });
      expect(second).toEqual({ total: 42 });
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('stores entries with the requested TTL', async () => {
      await cache.wrap('k', () => Promise.resolve('v'), 90);
      expect(redis.set).toHaveBeenCalledWith('k', '"v"', 'EX', 90);
    });

    it('deduplicates concurrent misses into a single load', async () => {
      // The stampede case: N simultaneous requests for a cold key must issue
      // one database query, not N.
      //
      // The deferred promise is created up front rather than inside the loader:
      // `wrap` awaits a Redis `get` before ever calling the loader, so
      // capturing `resolve` from within the loader would still be unset at the
      // point the test tries to fire it.
      let resolveLoader!: (value: string) => void;
      const pending = new Promise<string>((resolve) => {
        resolveLoader = resolve;
      });
      const loader = jest.fn(() => pending);

      const all = Promise.all([
        cache.wrap('k', loader),
        cache.wrap('k', loader),
        cache.wrap('k', loader),
      ]);

      // Let the three `get` round-trips settle so all three reach the loader
      // and register against the in-flight map before it resolves.
      await Promise.resolve();
      await Promise.resolve();
      resolveLoader('once');

      expect(await all).toEqual(['once', 'once', 'once']);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('does not cache a rejected loader', async () => {
      const failing = jest.fn().mockRejectedValue(new Error('db down'));
      await expect(cache.wrap('k', failing)).rejects.toThrow('db down');

      // The next call must retry rather than replay a memoised error.
      const ok = jest.fn().mockResolvedValue('recovered');
      await expect(cache.wrap('k', ok)).resolves.toBe('recovered');
      expect(ok).toHaveBeenCalledTimes(1);
    });

    it('deletes every key under a prefix via SCAN, never KEYS', async () => {
      await cache.set('hh:1:dashboard', 'a');
      await cache.set('hh:1:forecast:6', 'b');
      await cache.set('hh:2:dashboard', 'keep');

      await cache.delByPrefix('hh:1:');

      expect(redis.store.has('money-space:hh:1:dashboard')).toBe(false);
      expect(redis.store.has('money-space:hh:1:forecast:6')).toBe(false);
      // A neighbouring household must survive.
      expect(redis.store.get('money-space:hh:2:dashboard')).toBe('"keep"');
    });

    it('skips undefined values, which do not survive JSON round-tripping', async () => {
      await cache.set('k', undefined);
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  describe('fail-open contract', () => {
    it('falls through to the loader when Redis errors', async () => {
      redis.failWith = new Error('ECONNREFUSED');
      const loader = jest.fn().mockResolvedValue('from-db');

      await expect(cache.wrap('k', loader)).resolves.toBe('from-db');
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('reports a miss rather than throwing on a read error', async () => {
      redis.failWith = new Error('ECONNREFUSED');
      await expect(cache.get('k')).resolves.toBeUndefined();
    });

    it('swallows write and delete errors', async () => {
      redis.failWith = new Error('ECONNREFUSED');
      await expect(cache.set('k', 'v')).resolves.toBeUndefined();
      await expect(cache.del('k')).resolves.toBeUndefined();
      await expect(cache.delByPrefix('hh:1:')).resolves.toBeUndefined();
    });

    it('treats malformed JSON as a miss instead of crashing the request', async () => {
      redis.store.set('k', '{not json');
      await expect(cache.get('k')).resolves.toBeUndefined();
    });
  });

  describe('when caching is disabled', () => {
    it('runs the loader every time and touches no client', async () => {
      const disabled = new CacheService();
      const loader = jest.fn().mockResolvedValue('v');

      await disabled.wrap('k', loader);
      await disabled.wrap('k', loader);

      expect(disabled.enabled).toBe(false);
      expect(loader).toHaveBeenCalledTimes(2);
    });
  });
});
