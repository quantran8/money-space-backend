import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { HouseholdsController } from './households.controller';
import { HouseholdsService } from './households.service';
import { HOUSEHOLDS_REPOSITORY } from './repositories/households.repository.interface';
import { PrismaHouseholdsRepository } from './repositories/prisma-households.repository';

@Module({
  // BillingModule: a new household is granted its 14-day trial as it is
  // created.
  imports: [CommonModule, AuthModule, BillingModule],
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
