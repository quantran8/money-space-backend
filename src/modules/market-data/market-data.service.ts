import { Inject, Injectable } from '@nestjs/common';
import { MARKET_DATA_AS_OF } from '../../common/seed/money-space.seed';
import type { ListFxRatesQuery } from './dto/list-fx-rates.query';
import type { ListMarketPricesQuery } from './dto/list-market-prices.query';
import { MARKET_DATA_REPOSITORY } from './repositories/market-data.repository.interface';
import type { MarketDataRepository } from './repositories/market-data.repository.interface';
import type { MarketPrice } from './entities/market-price.entity';
import { PRICE_PROVIDER } from './providers/price-provider.interface';
import type { PriceProvider } from './providers/price-provider.interface';

@Injectable()
export class MarketDataService {
  constructor(
    @Inject(MARKET_DATA_REPOSITORY)
    private readonly marketDataRepository: MarketDataRepository,
    @Inject(PRICE_PROVIDER)
    private readonly priceProvider: PriceProvider,
  ) {}

  private cachedPrices: MarketPrice[] = [];
  private pricesExpireAt = 0;
  private pricesInFlight?: Promise<MarketPrice[]>;

  /** Latest provider quotes with a short-lived process cache; nothing is persisted. */
  async getMarketPrices(forceRefresh = false): Promise<MarketPrice[]> {
    const now = Date.now();
    if (!forceRefresh && now < this.pricesExpireAt) return this.cachedPrices;
    if (this.pricesInFlight) return this.pricesInFlight;
    const ttl = Number(process.env.MARKET_PRICE_CACHE_TTL_MS ?? 300_000);
    this.pricesInFlight = this.priceProvider
      .getLatestPrices()
      .then((prices) => {
        this.cachedPrices = prices;
        this.pricesExpireAt = Date.now() + (Number.isFinite(ttl) ? ttl : 300_000);
        return prices;
      })
      .catch((error) => {
        if (this.cachedPrices.length > 0) return this.cachedPrices;
        throw error;
      })
      .finally(() => {
        this.pricesInFlight = undefined;
      });
    return this.pricesInFlight;
  }

  async listMarketPrices(query: ListMarketPricesQuery) {
    let items = [...(await this.getMarketPrices())];
    if (query.assetClass) {
      items = items.filter((price) => price.assetClass === query.assetClass);
    }
    if (query.symbol) {
      items = items.filter(
        (price) => price.symbol.toUpperCase() === query.symbol?.toUpperCase(),
      );
    }

    return {
      asOf: MARKET_DATA_AS_OF,
      items,
      total: items.length,
    };
  }

  async listFxRates(query: ListFxRatesQuery) {
    let items = [...(await this.marketDataRepository.getFxRates())];
    if (query.baseCurrency) {
      items = items.filter(
        (rate) =>
          rate.baseCurrency.toUpperCase() === query.baseCurrency?.toUpperCase(),
      );
    }
    if (query.quoteCurrency) {
      items = items.filter(
        (rate) =>
          rate.quoteCurrency.toUpperCase() ===
          query.quoteCurrency?.toUpperCase(),
      );
    }

    return {
      asOf: MARKET_DATA_AS_OF,
      items,
      total: items.length,
    };
  }
}
