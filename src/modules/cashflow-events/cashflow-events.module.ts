import { Module, forwardRef } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { MoneyEventsModule } from '../money-events/money-events.module';
import { AssetsModule } from '../assets/assets.module';
import { CashflowEventsController } from './cashflow-events.controller';
import { CashflowEventsService } from './cashflow-events.service';
import { CASHFLOW_EVENTS_REPOSITORY } from './repositories/cashflow-events.repository.interface';
import { PrismaCashflowEventsRepository } from './repositories/prisma-cashflow-events.repository';

/**
 * `forwardRef` on MoneyEventsModule: completing a cashflow event creates a
 * money event (so wallet effects and the goal mirror fire), while deleting a
 * debt reaches the other way. The cycle is real and intentional.
 *
 * AssetsModule is here so completion can verify the settling wallet really is
 * flexible money and really holds a balance — otherwise the completion writes
 * an event that moves nothing.
 */
@Module({
  imports: [
    CommonModule,
    forwardRef(() => MoneyEventsModule),
    forwardRef(() => AssetsModule),
  ],
  controllers: [CashflowEventsController],
  providers: [
    CashflowEventsService,
    {
      provide: CASHFLOW_EVENTS_REPOSITORY,
      useClass: PrismaCashflowEventsRepository,
    },
  ],
  exports: [CashflowEventsService],
})
export class CashflowEventsModule {}
