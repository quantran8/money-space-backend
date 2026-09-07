import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { EXPORT_REPOSITORY } from './repositories/export.repository.interface';
import { PrismaExportRepository } from './repositories/prisma-export.repository';

/**
 * Data export (spec §J) — the `exportData` limit from Phase 1, finally built.
 *
 * Its own module rather than a route on each domain module: an export is one
 * file across every table, and hanging it off Assets or Money Events would put
 * a cross-domain read inside a module that owns one of them.
 *
 * It imports no domain module. The gate is `@RequirePremium`, which
 * `EntitlementGuard` enforces globally from `AuthModule`, so nothing here
 * depends on Billing either.
 */
@Module({
  imports: [CommonModule],
  controllers: [ExportController],
  providers: [
    ExportService,
    {
      provide: EXPORT_REPOSITORY,
      useClass: PrismaExportRepository,
    },
  ],
  exports: [ExportService],
})
export class ExportModule {}
