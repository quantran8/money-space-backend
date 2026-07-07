import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { MarketDataController } from './market-data.controller';
import { MarketDataService } from './market-data.service';
import { MARKET_DATA_REPOSITORY } from './repositories/market-data.repository.interface';
import { PrismaMarketDataRepository } from './repositories/prisma-market-data.repository';

@Module({
  imports: [CommonModule],
  controllers: [MarketDataController],
  providers: [
    MarketDataService,
    {
      provide: MARKET_DATA_REPOSITORY,
      useClass: PrismaMarketDataRepository,
    },
  ],
  exports: [MarketDataService],
})
export class MarketDataModule {}
