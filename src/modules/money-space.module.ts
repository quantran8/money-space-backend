import { Module } from '@nestjs/common';
import { AssetsModule } from './assets/assets.module';
import { AuthModule } from './auth/auth.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DebtsModule } from './debts/debts.module';
import { GoalsModule } from './goals/goals.module';
import { HouseholdsModule } from './households/households.module';
import { MarketDataModule } from './market-data/market-data.module';
import { MembersModule } from './members/members.module';
import { MoneyEventsModule } from './money-events/money-events.module';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    AuthModule,
    HouseholdsModule,
    DashboardModule,
    AssetsModule,
    DebtsModule,
    MembersModule,
    MoneyEventsModule,
    GoalsModule,
    PaymentsModule,
    MarketDataModule,
  ],
  exports: [
    AuthModule,
    HouseholdsModule,
    DashboardModule,
    AssetsModule,
    DebtsModule,
    MembersModule,
    MoneyEventsModule,
    GoalsModule,
    PaymentsModule,
    MarketDataModule,
  ],
})
export class MoneySpaceModule {}
