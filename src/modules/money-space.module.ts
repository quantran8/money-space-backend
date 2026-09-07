import { Module } from '@nestjs/common';
import { AssetsModule } from './assets/assets.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DebtsModule } from './debts/debts.module';
import { GoalsModule } from './goals/goals.module';
import { HouseholdsModule } from './households/households.module';
import { MarketDataModule } from './market-data/market-data.module';
import { MembersModule } from './members/members.module';
import { MoneyEventCategoriesModule } from './money-event-categories/money-event-categories.module';
import { MoneyEventsModule } from './money-events/money-events.module';
import { CashflowEventsModule } from './cashflow-events/cashflow-events.module';
import { ForecastModule } from './forecast/forecast.module';
import { AttentionModule } from './attention/attention.module';
import { InvitesModule } from './invites/invites.module';
import { ActivityModule } from './activity/activity.module';
import { SnapshotsModule } from './snapshots/snapshots.module';
import { ExportModule } from './export/export.module';

@Module({
  imports: [
    AuthModule,
    BillingModule,
    HouseholdsModule,
    DashboardModule,
    AssetsModule,
    DebtsModule,
    MembersModule,
    MoneyEventCategoriesModule,
    MoneyEventsModule,
    GoalsModule,
    CashflowEventsModule,
    ForecastModule,
    AttentionModule,
    InvitesModule,
    MarketDataModule,
    SnapshotsModule,
    ActivityModule,
    ExportModule,
  ],
  exports: [
    AuthModule,
    BillingModule,
    HouseholdsModule,
    DashboardModule,
    AssetsModule,
    DebtsModule,
    MembersModule,
    MoneyEventCategoriesModule,
    MoneyEventsModule,
    GoalsModule,
    CashflowEventsModule,
    ForecastModule,
    AttentionModule,
    InvitesModule,
    MarketDataModule,
    SnapshotsModule,
    ActivityModule,
    ExportModule,
  ],
})
export class MoneySpaceModule {}
