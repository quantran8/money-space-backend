import type { AssetClass } from './asset.entity';

export interface MarketPosition {
  assetClass: AssetClass;
  symbol: string;
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
