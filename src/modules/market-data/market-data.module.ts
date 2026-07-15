import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { MarketDataController } from './market-data.controller';
import { MarketDataService } from './market-data.service';
import { MARKET_DATA_REPOSITORY } from './repositories/market-data.repository.interface';
import { PrismaMarketDataRepository } from './repositories/prisma-market-data.repository';
import { NoopPriceProvider } from './providers/noop-price.provider';
import { TwelveDataPriceProvider } from './providers/twelve-data-price.provider';
import { PRICE_PROVIDER } from './providers/price-provider.interface';
import type { PriceProvider } from './providers/price-provider.interface';
import { NoopSymbolReferenceProvider } from './providers/noop-symbol-reference.provider';
import { TwelveDataSymbolReferenceProvider } from './providers/twelve-data-symbol-reference.provider';
import { SYMBOL_REFERENCE_PROVIDER } from './providers/symbol-reference-provider.interface';
import type { SymbolReferenceProvider } from './providers/symbol-reference-provider.interface';

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
    TwelveDataPriceProvider,
    {
      // Use the real Twelve Data adapter once an API key is configured; fall
      // back to the noop provider (empty quotes) otherwise so key-less
      // environments keep working.
      provide: PRICE_PROVIDER,
      useFactory: (
        twelveData: TwelveDataPriceProvider,
        noop: NoopPriceProvider,
      ): PriceProvider => (process.env.TWELVEDATA_API_KEY ? twelveData : noop),
      inject: [TwelveDataPriceProvider, NoopPriceProvider],
    },
    NoopSymbolReferenceProvider,
    TwelveDataSymbolReferenceProvider,
    {
      // Same key-gated selection for symbol reference data.
      provide: SYMBOL_REFERENCE_PROVIDER,
      useFactory: (
        twelveData: TwelveDataSymbolReferenceProvider,
        noop: NoopSymbolReferenceProvider,
      ): SymbolReferenceProvider =>
        process.env.TWELVEDATA_API_KEY ? twelveData : noop,
      inject: [TwelveDataSymbolReferenceProvider, NoopSymbolReferenceProvider],
    },
  ],
  exports: [MarketDataService],
})
export class MarketDataModule {}
