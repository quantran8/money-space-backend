import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { BillingModule } from '../billing/billing.module';
import { GoalsModule } from '../goals/goals.module';
import { ForecastController } from './forecast.controller';
import { ForecastService } from './forecast.service';
import { FORECAST_REPOSITORY } from './repositories/forecast.repository.interface';
import { PrismaForecastRepository } from './repositories/prisma-forecast.repository';

/**
 * Imports GoalsModule one-way (for the goal repository token). Goals must NOT
 * import Forecast — the projection domain is a pure function that Goals can use
 * directly if it ever needs to.
 */
@Module({
  // BillingModule: the horizon a household may ask for, and the monthly
  // what-if quota. Both are counted/resolved in the service, where
  // `householdId` already is.
  imports: [CommonModule, GoalsModule, BillingModule],
  controllers: [ForecastController],
  providers: [
    ForecastService,
    {
      provide: FORECAST_REPOSITORY,
      useClass: PrismaForecastRepository,
    },
  ],
  exports: [ForecastService],
})
export class ForecastModule {}
