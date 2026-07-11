import type { AssetClass } from './asset.entity';

export interface MarketPosition {
  assetClass: AssetClass;
  symbol: string;
  quantity: number;
  unit: string;
  quoteCurrency: string;
  /**
   * User-entered price of one `unit` in `quoteCurrency` (e.g. price of 1 BTC,
   * 1 share). When present, value = quantity × unitPrice × fx; the app falls
   * back to the cached market price otherwise.
   */
  unitPrice?: number;
}
