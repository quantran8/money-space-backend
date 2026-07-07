import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PAYMENTS_REPOSITORY } from './repositories/payments.repository.interface';
import { PrismaPaymentsRepository } from './repositories/prisma-payments.repository';

@Module({
  imports: [CommonModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    {
      provide: PAYMENTS_REPOSITORY,
      useClass: PrismaPaymentsRepository,
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
