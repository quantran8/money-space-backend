import type { AssetClass } from '../../assets/entities/asset.entity';

export interface MarketPrice {
  assetClass: AssetClass;
  symbol: string;
  price: number;
  unit: string;
  quoteCurrency: string;
  priceTime: string;
  source: string;
}
