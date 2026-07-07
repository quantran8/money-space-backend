import { Inject, Injectable } from '@nestjs/common';
import { MARKET_DATA_AS_OF } from '../../common/seed/money-space.seed';
import type { ListFxRatesQuery } from './dto/list-fx-rates.query';
import type { ListMarketPricesQuery } from './dto/list-market-prices.query';
import { MARKET_DATA_REPOSITORY } from './repositories/market-data.repository.interface';
import type { MarketDataRepository } from './repositories/market-data.repository.interface';

@Injectable()
export class MarketDataService {
  constructor(
    @Inject(MARKET_DATA_REPOSITORY)
    private readonly marketDataRepository: MarketDataRepository,
  ) {}

  async listMarketPrices(query: ListMarketPricesQuery) {
    let items = [...(await this.marketDataRepository.getMarketPrices())];
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
          rate.quoteCurrency.toUpperCase() === query.quoteCurrency?.toUpperCase(),
      );
    }

    return {
      asOf: MARKET_DATA_AS_OF,
      items,
      total: items.length,
    };
  }
}
