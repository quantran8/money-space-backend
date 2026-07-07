import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';
import { GOALS_REPOSITORY } from './repositories/goals.repository.interface';
import { PrismaGoalsRepository } from './repositories/prisma-goals.repository';

@Module({
  imports: [CommonModule],
  controllers: [GoalsController],
  providers: [
    GoalsService,
    {
      provide: GOALS_REPOSITORY,
      useClass: PrismaGoalsRepository,
    },
  ],
  exports: [GoalsService],
})
export class GoalsModule {}
