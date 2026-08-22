import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CacheModule } from './common/cache/cache.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { CacheInvalidationInterceptor } from './common/interceptors/cache-invalidation.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { DatabaseModule } from './database/database.module';
import { MoneySpaceModule } from './modules/money-space.module';

@Module({
  imports: [
    // Loads .env into process.env. Must stay first: services read
    // process.env in their field initializers, and forRoot() populates
    // process.env while this imports array is evaluated — i.e. before any
    // provider is instantiated. Without it only Prisma sees .env (it loads
    // the file itself), so every other env var reads as undefined.
    ConfigModule.forRoot({ isGlobal: true }),
    // Drives the daily market-valuation capture (`AssetsValuationCron`). Every
    // instance runs its own scheduler — see that class for the multi-instance
    // note and the env switch that disables it per instance.
    ScheduleModule.forRoot(),
    DatabaseModule,
    CacheModule,
    MoneySpaceModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Registered first so it wraps ResponseInterceptor: logs the raw request
    // on the way in and the final response/duration on the way out.
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
    // Innermost: runs after the handler resolves, so it only invalidates once
    // the write has actually committed.
    {
      provide: APP_INTERCEPTOR,
      useClass: CacheInvalidationInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}
