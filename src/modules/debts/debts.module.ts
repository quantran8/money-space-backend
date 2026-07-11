import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { MoneyEventsModule } from '../money-events/money-events.module';
import { PaymentsModule } from '../payments/payments.module';
import { DebtsController } from './debts.controller';
import { DebtsService } from './debts.service';
import { DEBTS_REPOSITORY } from './repositories/debts.repository.interface';
import { PrismaDebtsRepository } from './repositories/prisma-debts.repository';

@Module({
  imports: [CommonModule, MoneyEventsModule, PaymentsModule],
  controllers: [DebtsController],
  providers: [
    DebtsService,
    {
      provide: DEBTS_REPOSITORY,
      useClass: PrismaDebtsRepository,
    },
  ],
  exports: [DebtsService],
})
export class DebtsModule {}
