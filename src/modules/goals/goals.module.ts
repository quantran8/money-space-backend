import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { AssetsModule } from '../assets/assets.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { SNAPSHOTS_REPOSITORY } from '../snapshots/repositories/snapshots.repository.interface';
import { PrismaSnapshotsRepository } from '../snapshots/repositories/prisma-snapshots.repository';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';
import { GOALS_REPOSITORY } from './repositories/goals.repository.interface';
import { PrismaGoalsRepository } from './repositories/prisma-goals.repository';

// AssetsModule: an asset_backed goal's progress is a share of live asset
// values, so resolving a goal card needs them. The edge is one-way — Assets
// knows nothing about goals — so there is no cycle.
@Module({
  imports: [CommonModule, AssetsModule, MarketDataModule],
  controllers: [GoalsController],
  providers: [
    GoalsService,
    {
      provide: GOALS_REPOSITORY,
      useClass: PrismaGoalsRepository,
    },
    // Bound directly rather than by importing SnapshotsModule: that module
    // imports Forecast, which imports Goals, so the module edge would be a
    // cycle. Only the frozen-points read is needed here.
    {
      provide: SNAPSHOTS_REPOSITORY,
      useClass: PrismaSnapshotsRepository,
    },
  ],
  // GOALS_REPOSITORY is exported so ForecastModule can read goals for the
  // projection without importing GoalsService (and without a cycle).
  exports: [GoalsService, GOALS_REPOSITORY],
})
export class GoalsModule {}
