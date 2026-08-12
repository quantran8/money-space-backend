import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { ProtectedReservesController } from './protected-reserves.controller';
import { ProtectedReservesService } from './protected-reserves.service';
import { PROTECTED_RESERVES_REPOSITORY } from './repositories/protected-reserves.repository.interface';
import { PrismaProtectedReservesRepository } from './repositories/prisma-protected-reserves.repository';

/**
 * A leaf module: nothing imports it. The forecast reads reserves through its
 * own bundle query rather than through this service, which keeps
 * ForecastModule free of another dependency edge.
 */
@Module({
  imports: [CommonModule],
  controllers: [ProtectedReservesController],
  providers: [
    ProtectedReservesService,
    {
      provide: PROTECTED_RESERVES_REPOSITORY,
      useClass: PrismaProtectedReservesRepository,
    },
  ],
  exports: [ProtectedReservesService, PROTECTED_RESERVES_REPOSITORY],
})
export class ProtectedReservesModule {}
