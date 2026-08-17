/**
 * Redis cache configuration.
 *
 * The cache is an optimisation, never a source of truth: with `REDIS_URL` unset
 * the app runs exactly as before, every read going straight to Postgres. That
 * keeps local dev and CI free of a Redis dependency.
 */
export const cacheConfig = {
  /** Unset → caching disabled entirely (no client is constructed). */
  url: process.env.REDIS_URL,

  /**
   * Prefixed onto every key so multiple environments can share one Redis
   * instance without colliding, and so `FLUSHDB` is never needed to clear
   * just this app's keys.
   */
  keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'money-space',

  /** Default entry lifetime. Per-call TTLs override this. */
  defaultTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 300),

  /**
   * Cap on how long a single Redis round-trip may take before we give up and
   * fall through to Postgres. A slow cache must never be slower than the query
   * it was meant to avoid.
   */
  timeoutMs: Number(process.env.CACHE_TIMEOUT_MS ?? 250),

  /** Disabled under `NODE_ENV=test` so unit tests never touch a real Redis. */
  isTest: process.env.NODE_ENV === 'test',
};
