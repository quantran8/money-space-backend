import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { AssetsModule } from '../assets/assets.module';
import { SnapshotsModule } from '../snapshots/snapshots.module';
import { MoneyEventsController } from './money-events.controller';
import { MoneyEventsService } from './money-events.service';
import { MONEY_EVENTS_REPOSITORY } from './repositories/money-events.repository.interface';
import { PrismaMoneyEventsRepository } from './repositories/prisma-money-events.repository';

@Module({
  imports: [CommonModule, AssetsModule, SnapshotsModule],
  controllers: [MoneyEventsController],
  providers: [
    MoneyEventsService,
    {
      provide: MONEY_EVENTS_REPOSITORY,
      useClass: PrismaMoneyEventsRepository,
    },
  ],
  exports: [MoneyEventsService],
})
export class MoneyEventsModule {}
