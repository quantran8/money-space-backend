import type { FxRate } from '../entities/fx-rate.entity';
import type { SymbolRequest } from '../providers/symbol-request';

export const MARKET_DATA_REPOSITORY = Symbol('MARKET_DATA_REPOSITORY');

export interface MarketDataRepository {
  getFxRates(): Promise<FxRate[]>;
  /**
   * The distinct set of market positions to price — one entry per
   * (assetClass, symbol) held by any household. Feeds the batched provider call.
   */
  getMarketSymbolUniverse(): Promise<SymbolRequest[]>;
}
