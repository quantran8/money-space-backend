import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { SnapshotsModule } from '../snapshots/snapshots.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { ASSETS_REPOSITORY } from './repositories/assets.repository.interface';
import { PrismaAssetsRepository } from './repositories/prisma-assets.repository';

@Module({
  imports: [CommonModule, SnapshotsModule, MarketDataModule],
  controllers: [AssetsController],
  providers: [
    AssetsService,
    {
      provide: ASSETS_REPOSITORY,
      useClass: PrismaAssetsRepository,
    },
  ],
  exports: [AssetsService],
})
export class AssetsModule {}
