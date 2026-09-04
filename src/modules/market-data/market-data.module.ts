import { Module } from '@nestjs/common';
import { CacheModule } from '../../common/cache/cache.module';
import { CommonModule } from '../../common/common.module';
import { MarketDataController } from './market-data.controller';
import { MarketDataService } from './market-data.service';
import { MARKET_DATA_REPOSITORY } from './repositories/market-data.repository.interface';
import { PrismaMarketDataRepository } from './repositories/prisma-market-data.repository';
import { NoopPriceProvider } from './providers/noop-price.provider';
import { TwelveDataPriceProvider } from './providers/twelve-data-price.provider';
import { CoinMarketCapPriceProvider } from './providers/coinmarketcap-price.provider';
import { VnstockPriceProvider } from './providers/vnstock-price.provider';
import { VnstockCommodityProvider } from './providers/vnstock-commodity.provider';
import { NoopCommodityProvider } from './providers/noop-commodity.provider';
import { COMMODITY_PROVIDER } from './providers/commodity-provider.interface';
import type { CommodityProvider } from './providers/commodity-provider.interface';
import { CommodityPriceProvider } from './providers/commodity-price.provider';
import { CompositePriceProvider } from './providers/composite-price.provider';
import { PRICE_PROVIDER } from './providers/price-provider.interface';
import type { PriceProvider } from './providers/price-provider.interface';
import { NoopSymbolReferenceProvider } from './providers/noop-symbol-reference.provider';
import { TwelveDataSymbolReferenceProvider } from './providers/twelve-data-symbol-reference.provider';
import { CoinMarketCapSymbolReferenceProvider } from './providers/coinmarketcap-symbol-reference.provider';
import { VnstockSymbolReferenceProvider } from './providers/vnstock-symbol-reference.provider';
import { VnstockCommoditySymbolReferenceProvider } from './providers/vnstock-commodity-symbol-reference.provider';
import { CompositeSymbolReferenceProvider } from './providers/composite-symbol-reference.provider';
import { SYMBOL_REFERENCE_PROVIDER } from './providers/symbol-reference-provider.interface';
import type { SymbolReferenceProvider } from './providers/symbol-reference-provider.interface';
import {
  priceOverrides,
  priceRoutes,
  providerKeysFromEnv,
  symbolReferenceRoutes,
} from './providers/provider-routing';

@Module({
  // CacheModule is @Global() under AppModule, but importing it explicitly means
  // this module also stands up on its own (tests, a standalone context).
  imports: [CommonModule, CacheModule],
  controllers: [MarketDataController],
  providers: [
    MarketDataService,
    {
      provide: MARKET_DATA_REPOSITORY,
      useClass: PrismaMarketDataRepository,
    },
    NoopPriceProvider,
    TwelveDataPriceProvider,
    CoinMarketCapPriceProvider,
    VnstockPriceProvider,
    CommodityPriceProvider,
    {
      // Route each class to the provider that quotes it (see `provider-routing`);
      // with no key configured at all, fall back to the noop provider so
      // key-less environments keep working.
      provide: PRICE_PROVIDER,
      useFactory: (
        twelveData: TwelveDataPriceProvider,
        coinMarketCap: CoinMarketCapPriceProvider,
        vnstock: VnstockPriceProvider,
        commodity: CommodityPriceProvider,
        noop: NoopPriceProvider,
      ): PriceProvider => {
        const routes = priceRoutes(providerKeysFromEnv(), {
          twelveData,
          coinMarketCap,
          commodity,
        });
        // vnstock needs no key, so there is always at least this route.
        const overrides = priceOverrides({ vnstock });
        return routes.size > 0 || overrides.length > 0
          ? new CompositePriceProvider(routes, overrides)
          : noop;
      },
      inject: [
        TwelveDataPriceProvider,
        CoinMarketCapPriceProvider,
        VnstockPriceProvider,
        CommodityPriceProvider,
        NoopPriceProvider,
      ],
    },
    NoopCommodityProvider,
    VnstockCommodityProvider,
    {
      // vnstock needs no API key, so the real adapter is always used; the noop
      // stays registered as the documented fallback if that ever changes.
      provide: COMMODITY_PROVIDER,
      useFactory: (vnstock: VnstockCommodityProvider): CommodityProvider =>
        vnstock,
      inject: [VnstockCommodityProvider],
    },
    NoopSymbolReferenceProvider,
    TwelveDataSymbolReferenceProvider,
    CoinMarketCapSymbolReferenceProvider,
    VnstockSymbolReferenceProvider,
    VnstockCommoditySymbolReferenceProvider,
    {
      // Same per-class routing for reference data, so the symbol picker lists
      // crypto from CoinMarketCap and stocks from Twelve Data.
      provide: SYMBOL_REFERENCE_PROVIDER,
      useFactory: (
        twelveData: TwelveDataSymbolReferenceProvider,
        coinMarketCap: CoinMarketCapSymbolReferenceProvider,
        vnstock: VnstockSymbolReferenceProvider,
        commodity: VnstockCommoditySymbolReferenceProvider,
        noop: NoopSymbolReferenceProvider,
      ): SymbolReferenceProvider => {
        const routes = symbolReferenceRoutes(providerKeysFromEnv(), {
          twelveData,
          coinMarketCap,
          vnstock,
          commodity,
        });
        return routes.size > 0
          ? new CompositeSymbolReferenceProvider(routes)
          : noop;
      },
      inject: [
        TwelveDataSymbolReferenceProvider,
        CoinMarketCapSymbolReferenceProvider,
        VnstockSymbolReferenceProvider,
        VnstockCommoditySymbolReferenceProvider,
        NoopSymbolReferenceProvider,
      ],
    },
  ],
  exports: [MarketDataService],
})
export class MarketDataModule {}
