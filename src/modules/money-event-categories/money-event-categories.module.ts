import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { MoneyEventCategoriesController } from './money-event-categories.controller';
import { MoneyEventCategoriesService } from './money-event-categories.service';
import { MONEY_EVENT_CATEGORIES_REPOSITORY } from './repositories/money-event-categories.repository.interface';
import { PrismaMoneyEventCategoriesRepository } from './repositories/prisma-money-event-categories.repository';

@Module({
  imports: [CommonModule],
  controllers: [MoneyEventCategoriesController],
  providers: [
    MoneyEventCategoriesService,
    {
      provide: MONEY_EVENT_CATEGORIES_REPOSITORY,
      useClass: PrismaMoneyEventCategoriesRepository,
    },
  ],
  exports: [MoneyEventCategoriesService],
})
export class MoneyEventCategoriesModule {}
