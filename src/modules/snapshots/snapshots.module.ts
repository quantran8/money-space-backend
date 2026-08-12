import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';
import { SNAPSHOTS_REPOSITORY } from './repositories/snapshots.repository.interface';
import { PrismaSnapshotsRepository } from './repositories/prisma-snapshots.repository';
import { MarketDataModule } from '../market-data/market-data.module';
import { AttentionModule } from '../attention/attention.module';
import { ForecastModule } from '../forecast/forecast.module';

/**
 * Reads assets through its own repository + the pure `computeCurrentValue`
 * util rather than through AssetsService, so this stays free of AssetsModule.
 *
 * Imports Forecast + Attention one-way, to freeze the foresight columns and the
 * stored-attention count. Nothing imports SnapshotsModule any more: the
 * auto-snapshot hooks that Assets/Debts/MoneyEvents used to call were retired,
 * and their now-dead injections went with them.
 */
@Module({
  imports: [CommonModule, MarketDataModule, ForecastModule, AttentionModule],
  controllers: [SnapshotsController],
  providers: [
    SnapshotsService,
    {
      provide: SNAPSHOTS_REPOSITORY,
      useClass: PrismaSnapshotsRepository,
    },
  ],
  exports: [SnapshotsService],
})
export class SnapshotsModule {}
