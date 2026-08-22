import { Injectable, Logger } from '@nestjs/common';

import { CacheService } from '../../common/cache/cache.service';

/**
 * PKCE `code_verifier` storage, spanning the two requests the OAuth round-trip
 * takes: `GET /auth/google` mints it, `POST /auth/google/callback` consumes it.
 *
 * See `memory/google-oauth.md` for why the flow is shaped this way.
 */
@Injectable()
export class OauthVerifierStore {
  private readonly logger = new Logger(OauthVerifierStore.name);

  /**
   * Fallback for when Redis is absent (local dev, CI, tests). The cache is
   * deliberately fail-open — a miss there costs latency, not correctness — but
   * a lost verifier fails the login outright, so this never relies on it alone.
   * Only correct for a single instance; Redis is what makes it work across many.
   */
  private readonly local = new Map<
    string,
    { value: string; expiresAt: number }
  >();

  constructor(private readonly cache: CacheService) {}

  async set(key: string, verifier: string, ttlSeconds: number): Promise<void> {
    this.sweep();
    this.local.set(key, {
      value: verifier,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    await this.cache.set(key, verifier, ttlSeconds);
  }

  /** Single-use: reading a verifier also retires it, so a code cannot be replayed. */
  async take(key: string): Promise<string | undefined> {
    const fromCache = await this.cache.get<string>(key);
    const local = this.local.get(key);
    this.local.delete(key);
    await this.cache.del(key);

    if (fromCache) return fromCache;
    if (local && local.expiresAt > Date.now()) return local.value;

    if (local) this.logger.warn('PKCE verifier expired before the callback.');
    return undefined;
  }

  private sweep() {
    const now = Date.now();
    for (const [key, entry] of this.local) {
      if (entry.expiresAt <= now) this.local.delete(key);
    }
  }
}
