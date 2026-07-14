import type { FxRate } from '../entities/fx-rate.entity';

export const MARKET_DATA_REPOSITORY = Symbol('MARKET_DATA_REPOSITORY');

export interface MarketDataRepository {
  getFxRates(): Promise<FxRate[]>;
}
