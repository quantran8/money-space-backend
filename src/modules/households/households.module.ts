import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { HouseholdsController } from './households.controller';
import { HouseholdsService } from './households.service';
import { HOUSEHOLDS_REPOSITORY } from './repositories/households.repository.interface';
import { PrismaHouseholdsRepository } from './repositories/prisma-households.repository';

@Module({
  imports: [CommonModule],
  controllers: [HouseholdsController],
  providers: [
    HouseholdsService,
    {
      provide: HOUSEHOLDS_REPOSITORY,
      useClass: PrismaHouseholdsRepository,
    },
  ],
  exports: [HouseholdsService],
})
export class HouseholdsModule {}
