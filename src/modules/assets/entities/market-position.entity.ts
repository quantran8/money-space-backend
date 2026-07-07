import type { AssetClass } from './asset.entity';

export interface MarketPosition {
  assetClass: AssetClass;
  symbol: string;
  quantity: number;
  unit: string;
  quoteCurrency: string;
}
