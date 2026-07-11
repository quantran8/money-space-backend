import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { AssetsModule } from '../assets/assets.module';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';
import { SNAPSHOTS_REPOSITORY } from './repositories/snapshots.repository.interface';
import { PrismaSnapshotsRepository } from './repositories/prisma-snapshots.repository';

@Module({
  imports: [CommonModule, AssetsModule],
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
