import { SetMetadata } from '@nestjs/common';

export const NO_CACHE_INVALIDATION = 'noCacheInvalidation';

/**
 * Marks a mutating-looking handler as read-only, so
 * `CacheInvalidationInterceptor` leaves the cache alone.
 *
 * For endpoints that are POST purely because they need a request body, not
 * because they write anything — `POST /what-if` being the case this exists for.
 * Without it a simulation would flush a perfectly valid cache on every run, and
 * what-if is exactly the endpoint users hit repeatedly in a row.
 */
export const NoCacheInvalidation = () =>
  SetMetadata(NO_CACHE_INVALIDATION, true);
