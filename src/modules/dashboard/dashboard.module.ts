import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { DASHBOARD_REPOSITORY } from './repositories/dashboard.repository.interface';
import { PrismaDashboardRepository } from './repositories/prisma-dashboard.repository';

@Module({
  imports: [CommonModule],
  controllers: [DashboardController],
  providers: [
    DashboardService,
    {
      provide: DASHBOARD_REPOSITORY,
      useClass: PrismaDashboardRepository,
    },
  ],
  exports: [DashboardService],
})
export class DashboardModule {}
