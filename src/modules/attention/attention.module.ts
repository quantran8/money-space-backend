import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { ForecastModule } from '../forecast/forecast.module';
import { AttentionController } from './attention.controller';
import { AttentionService } from './attention.service';
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
  ],
  exports: [AttentionService, ATTENTION_REPOSITORY],
})
export class AttentionModule {}
