import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { ForecastModule } from '../forecast/forecast.module';
import { AttentionController } from './attention.controller';
import { AttentionService } from './attention.service';
import { GOALS_REPOSITORY } from '../goals/repositories/goals.repository.interface';
import { PrismaGoalsRepository } from '../goals/repositories/prisma-goals.repository';
import { ATTENTION_REPOSITORY } from './repositories/attention.repository.interface';
import { PrismaAttentionRepository } from './repositories/prisma-attention.repository';

/**
 * Split out of DashboardModule, which returned attention items as a decorated
 * sub-field of the dashboard payload (with Vietnamese level labels baked in).
 *
 * Imports ForecastModule one-way: derived signals are read off the same bundle
 * the forecast already loads, so they cost no extra queries. Forecast must NOT
 * import this — attention depends on the calculation, never the reverse.
 */
@Module({
  imports: [CommonModule, ForecastModule],
  controllers: [AttentionController],
  providers: [
    AttentionService,
    {
      provide: ATTENTION_REPOSITORY,
      useClass: PrismaAttentionRepository,
    },
    // Bound directly rather than by importing GoalsModule: Goals imports
    // Forecast's neighbours and Forecast imports Goals, so the module edge
    // would be a cycle. `goal_without_wallet` needs only two plain reads.
    {
      provide: GOALS_REPOSITORY,
      useClass: PrismaGoalsRepository,
    },
  ],
  exports: [AttentionService, ATTENTION_REPOSITORY],
})
export class AttentionModule {}
