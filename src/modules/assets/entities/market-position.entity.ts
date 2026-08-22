import type { AssetClass } from './asset.entity';

export interface MarketPosition {
  assetClass: AssetClass;
  symbol: string;
  /**
   * Venue the instrument trades on, e.g. `HOSE`, `HNX`, `UPCOM`, `NASDAQ`.
   * Set from the symbol picker's reference data. Price routing reads it to tell
   * a Vietnamese listing from a foreign one — both are `assetClass: 'stock'` —
   * so leaving it unset falls back to a currency heuristic.
   */
  market?: string;
  quantity: number;
  unit: string;
  quoteCurrency: string;
  /**
   * Original purchase price of one unit. This is the cost basis and must not be
   * overwritten by a later manual revaluation.
   */
  purchasePrice?: number;
  /** Latest manually entered or externally fetched market price. */
  lastPrice?: number;
  /** ISO timestamp at which `lastPrice` was observed. */
  lastPriceAt?: string;
}
