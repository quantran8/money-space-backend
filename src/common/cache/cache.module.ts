import { Global, Module } from '@nestjs/common';
import { CacheInvalidator } from './cache-invalidator.service';
import { CacheService } from './cache.service';

/**
 * Global so any module can inject `CacheService` / `CacheInvalidator` without
 * importing this module — mirroring `PrismaModule`, and keeping write paths
 * from having to restructure their imports just to invalidate.
 */
@Global()
@Module({
  providers: [CacheService, CacheInvalidator],
  exports: [CacheService, CacheInvalidator],
})
export class CacheModule {}
