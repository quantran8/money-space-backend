import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { cacheConfig } from '../../config/cache.config';

/**
 * Redis-backed cache with a strict fail-open contract.
 *
 * **Every method swallows Redis errors.** A cache outage degrades latency, never
 * correctness: `get` reports a miss, `set`/`del` become no-ops, and the caller
 * falls through to Postgres exactly as if the entry had expired. Redis is
 * therefore never a single point of failure for the API.
 *
 * When `REDIS_URL` is unset (or `NODE_ENV=test`) no client is constructed at
 * all and every operation short-circuits — the app behaves as it did before the
 * cache existed.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private client: Redis | null = null;

  /**
   * Deduplicates concurrent misses for the same key *within this process*. Ten
   * simultaneous dashboard requests then issue one database query instead of
   * ten — the stampede protection that matters most on a cold key.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  /** Logged once per outage rather than per failed operation. */
  private degraded = false;

  onModuleInit() {
    if (cacheConfig.isTest || !cacheConfig.url) {
      this.logger.log(
        'Cache disabled (REDIS_URL not set); reads go straight to the database.',
      );
      return;
    }

    this.client = new Redis(cacheConfig.url, {
      keyPrefix: `${cacheConfig.keyPrefix}:`,
      // Fail fast instead of queueing commands while Redis is unreachable —
      // a queued command would block the request past any useful deadline.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });

    // Without an 'error' listener ioredis emits an unhandled 'error' event,
    // which crashes the process — the exact opposite of failing open.
    this.client.on('error', (error: Error) => this.markDegraded(error));
    this.client.on('ready', () => {
      if (this.degraded) {
        this.logger.log('Redis connection restored; caching resumed.');
      }
      this.degraded = false;
    });
  }

  async onModuleDestroy() {
    // quit() waits for in-flight commands; disconnect() is the hard fallback.
    try {
      await this.client?.quit();
    } catch {
      this.client?.disconnect();
    }
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /**
   * Read-through cache. On a hit the stored JSON is returned; on a miss (or any
   * Redis failure) `loader` runs and its result is stored before being
   * returned.
   *
   * A `loader` rejection propagates to the caller untouched and nothing is
   * cached — errors must never be memoised.
   */
  async wrap<T>(
    key: string,
    loader: () => Promise<T>,
    ttlSeconds: number = cacheConfig.defaultTtlSeconds,
  ): Promise<T> {
    if (!this.client) return loader();

    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    // Join an existing load for this key rather than starting a second one.
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const load = loader()
      .then(async (value) => {
        await this.set(key, value, ttlSeconds);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, load);
    return load;
  }

  /** Returns `undefined` on a miss, on malformed JSON, or on any Redis error. */
  async get<T>(key: string): Promise<T | undefined> {
    if (!this.client) return undefined;

    try {
      const raw = await this.withTimeout(this.client.get(key));
      if (raw === null || raw === undefined) return undefined;
      return JSON.parse(raw) as T;
    } catch (error) {
      this.markDegraded(error);
      return undefined;
    }
  }

  async set<T>(
    key: string,
    value: T,
    ttlSeconds: number = cacheConfig.defaultTtlSeconds,
  ): Promise<void> {
    if (!this.client) return;
    // `undefined` does not survive JSON.stringify — it would be stored as the
    // literal "undefined" and blow up JSON.parse on read.
    if (value === undefined) return;

    try {
      await this.withTimeout(
        this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds),
      );
    } catch (error) {
      this.markDegraded(error);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!this.client || keys.length === 0) return;

    try {
      await this.withTimeout(this.client.del(...keys));
    } catch (error) {
      this.markDegraded(error);
    }
  }

  /**
   * Deletes every key under `prefix`, used to drop a whole household's cached
   * views in one call.
   *
   * Uses SCAN, never KEYS: `KEYS` is O(n) over the entire keyspace and blocks
   * the single-threaded Redis server, which on a shared instance stalls every
   * other client. SCAN walks the keyspace in cursor-sized batches instead.
   *
   * Note ioredis applies `keyPrefix` to key *arguments* but not to the MATCH
   * pattern, and the keys SCAN returns already include the prefix — so the
   * pattern is prefixed manually and stripped from each result before DEL.
   */
  async delByPrefix(prefix: string): Promise<void> {
    if (!this.client) return;

    const fullPrefix = `${cacheConfig.keyPrefix}:`;
    const pattern = `${fullPrefix}${prefix}*`;

    try {
      let cursor = '0';
      do {
        const [next, found]: [string, string[]] = await this.withTimeout(
          this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200),
        );
        cursor = next;

        if (found.length > 0) {
          // Strip the prefix ioredis is about to re-apply, else keys would be
          // looked up as "money-space:money-space:…" and nothing gets deleted.
          const unprefixed = found.map((key) =>
            key.startsWith(fullPrefix) ? key.slice(fullPrefix.length) : key,
          );
          await this.withTimeout(this.client.del(...unprefixed));
        }
      } while (cursor !== '0');
    } catch (error) {
      this.markDegraded(error);
    }
  }

  /**
   * Bounds a Redis round-trip. Without this, a hung connection would hold the
   * request open far longer than the query the cache is meant to replace.
   */
  private withTimeout<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Redis timed out after ${cacheConfig.timeoutMs}ms`)),
        cacheConfig.timeoutMs,
      );
      operation.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /** Logs the first failure of an outage; stays quiet until Redis recovers. */
  private markDegraded(error: unknown) {
    if (this.degraded) return;
    this.degraded = true;
    this.logger.warn(
      `Redis unavailable — serving from the database. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
