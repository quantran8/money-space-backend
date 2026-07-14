import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { MarketDataController } from './market-data.controller';
import { MarketDataService } from './market-data.service';
import { MARKET_DATA_REPOSITORY } from './repositories/market-data.repository.interface';
import { PrismaMarketDataRepository } from './repositories/prisma-market-data.repository';
import { NoopPriceProvider } from './providers/noop-price.provider';
import { PRICE_PROVIDER } from './providers/price-provider.interface';

@Module({
  imports: [CommonModule],
  controllers: [MarketDataController],
  providers: [
    MarketDataService,
    {
      provide: MARKET_DATA_REPOSITORY,
      useClass: PrismaMarketDataRepository,
    },
    NoopPriceProvider,
    { provide: PRICE_PROVIDER, useExisting: NoopPriceProvider },
  ],
  exports: [MarketDataService],
})
export class MarketDataModule {}
