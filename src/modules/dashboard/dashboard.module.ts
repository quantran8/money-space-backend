import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { DASHBOARD_REPOSITORY } from './repositories/dashboard.repository.interface';
import { PrismaDashboardRepository } from './repositories/prisma-dashboard.repository';
import { MarketDataModule } from '../market-data/market-data.module';
import { AssetsModule } from '../assets/assets.module';

@Module({
  imports: [CommonModule, MarketDataModule, AssetsModule],
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
