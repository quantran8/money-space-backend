import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { AssetsModule } from '../assets/assets.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { SNAPSHOTS_REPOSITORY } from '../snapshots/repositories/snapshots.repository.interface';
import { PrismaSnapshotsRepository } from '../snapshots/repositories/prisma-snapshots.repository';
import { CASHFLOW_EVENTS_REPOSITORY } from '../cashflow-events/repositories/cashflow-events.repository.interface';
import { PrismaCashflowEventsRepository } from '../cashflow-events/repositories/prisma-cashflow-events.repository';
import { AssetGoalUsageController } from './asset-goal-usage.controller';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';
import { GOALS_REPOSITORY } from './repositories/goals.repository.interface';
import { PrismaGoalsRepository } from './repositories/prisma-goals.repository';

// AssetsModule: an asset_backed goal's progress is a share of live asset
// values, so resolving a goal card needs them. The edge is one-way — Assets
// knows nothing about goals — so there is no cycle.
@Module({
  imports: [CommonModule, AssetsModule, MarketDataModule],
  // `AssetGoalUsageController` serves an /assets/:id/* route from here: the
  // answer needs goals, and AssetsModule cannot import this one without making
  // the existing Goals → Assets edge a cycle.
  controllers: [GoalsController, AssetGoalUsageController],
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
    // Same reasoning as SNAPSHOTS_REPOSITORY above: the running month's pace
    // must be net of outflows already scheduled against the backing wallet, and
    // only the plain read is needed. Importing CashflowEventsModule would drag
    // in MoneyEvents (which imports Goals) and make the edge a cycle.
    {
      provide: CASHFLOW_EVENTS_REPOSITORY,
      useClass: PrismaCashflowEventsRepository,
    },
  ],
  // GOALS_REPOSITORY is exported so ForecastModule can read goals for the
  // projection without importing GoalsService (and without a cycle).
  exports: [GoalsService, GOALS_REPOSITORY],
})
export class GoalsModule {}
