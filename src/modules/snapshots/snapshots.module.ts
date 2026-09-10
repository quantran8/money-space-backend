import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';
import { SNAPSHOTS_REPOSITORY } from './repositories/snapshots.repository.interface';
import { PrismaSnapshotsRepository } from './repositories/prisma-snapshots.repository';
import { MarketDataModule } from '../market-data/market-data.module';
import { ForecastModule } from '../forecast/forecast.module';
import { AssetsModule } from '../assets/assets.module';
import { GoalsModule } from '../goals/goals.module';
import { MonthEndCron } from './month-end.cron';

/**
 * Reads assets through its own repository + the pure `computeCurrentValue`
 * util rather than through AssetsService, so this stays free of AssetsModule.
 *
 * Imports Forecast one-way, to freeze the foresight columns. Nothing imports
 * SnapshotsModule any more: the
 * auto-snapshot hooks that Assets/Debts/MoneyEvents used to call were retired,
 * and their now-dead injections went with them.
 */
@Module({
  // Assets + Goals for `MonthEndCron`: it settles goal ledgers against wallet
  // values. Both edges are one-way — neither module imports this one (Goals
  // binds SNAPSHOTS_REPOSITORY directly for exactly that reason), so the
  // existing Snapshots → Forecast → Goals path stays acyclic.
  imports: [
    CommonModule,
    MarketDataModule,
    ForecastModule,
    AssetsModule,
    GoalsModule,
  ],
  controllers: [SnapshotsController],
  providers: [
    SnapshotsService,
    MonthEndCron,
    {
      provide: SNAPSHOTS_REPOSITORY,
      useClass: PrismaSnapshotsRepository,
    },
  ],
  // SNAPSHOTS_REPOSITORY is exported so GoalsModule can read a goal's frozen
  // progress points without importing SnapshotsService — Snapshots → Forecast →
  // Goals already exists, so the reverse module edge would be a cycle.
  exports: [SnapshotsService, SNAPSHOTS_REPOSITORY],
})
export class SnapshotsModule {}
