import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma/prisma.module';
import { AnalyticsService } from './analytics/analytics.service';
import { AuditService } from './audit/audit.service';

/**
 * `AnalyticsService` sits beside `AuditService` rather than in a `@Global()`
 * module of its own: every feature module already imports this one, so it is
 * injectable everywhere with no graph change, and a second mechanism for the
 * same job is what lets two of them drift.
 */
@Module({
  imports: [PrismaModule],
  providers: [AuditService, AnalyticsService],
  exports: [PrismaModule, AuditService, AnalyticsService],
})
export class CommonModule {}
