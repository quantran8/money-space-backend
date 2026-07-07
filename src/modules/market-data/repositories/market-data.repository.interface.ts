import type { FxRate } from '../entities/fx-rate.entity';
import type { MarketPrice } from '../entities/market-price.entity';

export const MARKET_DATA_REPOSITORY = Symbol('MARKET_DATA_REPOSITORY');

export interface MarketDataRepository {
  getMarketPrices(): Promise<MarketPrice[]>;
  getFxRates(): Promise<FxRate[]>;
}
