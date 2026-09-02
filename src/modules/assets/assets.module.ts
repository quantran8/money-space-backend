import { Module, forwardRef } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { MoneyEventsModule } from '../money-events/money-events.module';
import { GOALS_REPOSITORY } from '../goals/repositories/goals.repository.interface';
import { PrismaGoalsRepository } from '../goals/repositories/prisma-goals.repository';
import { CASHFLOW_EVENTS_REPOSITORY } from '../cashflow-events/repositories/cashflow-events.repository.interface';
import { PrismaCashflowEventsRepository } from '../cashflow-events/repositories/prisma-cashflow-events.repository';
import { DEBTS_REPOSITORY } from '../debts/repositories/debts.repository.interface';
import { PrismaDebtsRepository } from '../debts/repositories/prisma-debts.repository';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetsValuationCron } from './assets-valuation.cron';
import { ASSETS_REPOSITORY } from './repositories/assets.repository.interface';
import { PrismaAssetsRepository } from './repositories/prisma-assets.repository';

@Module({
  // `forwardRef` on MoneyEventsModule: deleting an asset deletes the money
  // events recorded through it, while MoneyEventsModule already imports this one
  // to validate and settle wallets — a genuine cycle, broken the way
  // CashflowEvents breaks its own.
  imports: [
    CommonModule,
    MarketDataModule,
    forwardRef(() => MoneyEventsModule),
  ],
  controllers: [AssetsController],
  providers: [
    AssetsService,
    // Daily capture of every market asset's value, so a household nobody opens
    // still gets a data point (see the class doc).
    AssetsValuationCron,
    {
      provide: ASSETS_REPOSITORY,
      useClass: PrismaAssetsRepository,
    },
    // Deleting an asset has to clear what points at it — goal claims, scheduled
    // events, debts — because those relations' `onDelete: Cascade` never fires
    // against a soft delete.
    //
    // Bound as REPOSITORIES rather than by importing GoalsModule /
    // CashflowEventsModule / DebtsModule: all three import AssetsModule, so the
    // module edge would be a cycle (CashflowEvents already needs `forwardRef`
    // for its own). Only plain reads and the unlink writes are wanted here, and
    // GoalsModule binds SNAPSHOTS_REPOSITORY and CASHFLOW_EVENTS_REPOSITORY
    // exactly this way for exactly this reason.
    {
      provide: GOALS_REPOSITORY,
      useClass: PrismaGoalsRepository,
    },
    {
      provide: CASHFLOW_EVENTS_REPOSITORY,
      useClass: PrismaCashflowEventsRepository,
    },
    {
      provide: DEBTS_REPOSITORY,
      useClass: PrismaDebtsRepository,
    },
  ],
  exports: [AssetsService],
})
export class AssetsModule {}
