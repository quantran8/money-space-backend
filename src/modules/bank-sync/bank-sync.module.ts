import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { BillingModule } from '../billing/billing.module';
import { AssetsModule } from '../assets/assets.module';
import { MoneyEventsModule } from '../money-events/money-events.module';
import { CashflowEventsModule } from '../cashflow-events/cashflow-events.module';
import { BankIngestController } from './controllers/bank-ingest.controller';
import { BankSyncController } from './controllers/bank-sync.controller';
import { BankIngestTokenGuard } from './guards/bank-ingest-token.guard';
import { BANK_SYNC_REPOSITORY } from './repositories/bank-sync.repository.interface';
import { PrismaBankSyncRepository } from './repositories/prisma-bank-sync.repository';
import { BankCredentialsService } from './services/bank-credentials.service';
import { BankEventsService } from './services/bank-events.service';
import { BankIngestService } from './services/bank-ingest.service';
import { BankPostingService } from './services/bank-posting.service';
import { BankRawRetentionCron } from './services/bank-raw-retention.cron';
import { BankSourcesService } from './services/bank-sources.service';

@Module({
  imports: [
    CommonModule,
    BillingModule,
    AssetsModule,
    MoneyEventsModule,
    CashflowEventsModule,
  ],
  controllers: [BankIngestController, BankSyncController],
  providers: [
    BankCredentialsService,
    BankSourcesService,
    BankIngestService,
    BankPostingService,
    BankEventsService,
    BankRawRetentionCron,
    BankIngestTokenGuard,
    { provide: BANK_SYNC_REPOSITORY, useClass: PrismaBankSyncRepository },
  ],
})
export class BankSyncModule {}
