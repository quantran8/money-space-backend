import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';
import { SNAPSHOTS_REPOSITORY } from './repositories/snapshots.repository.interface';
import { PrismaSnapshotsRepository } from './repositories/prisma-snapshots.repository';
import { MarketDataModule } from '../market-data/market-data.module';

// NOTE: does NOT import AssetsModule — snapshots reads assets via its own
// repository + the pure `computeCurrentValue` util, so this stays a low-level
// module that AssetsModule/MoneyEventsModule/DebtsModule can import one-way to
// call the auto-snapshot hooks without a dependency cycle.
@Module({
  imports: [CommonModule, MarketDataModule],
  controllers: [SnapshotsController],
  providers: [
    SnapshotsService,
    {
      provide: SNAPSHOTS_REPOSITORY,
      useClass: PrismaSnapshotsRepository,
    },
  ],
  exports: [SnapshotsService],
})
export class SnapshotsModule {}
