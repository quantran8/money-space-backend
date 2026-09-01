import type { AssetClass } from '../../assets/entities/asset.entity';

export interface MarketPrice {
  assetClass: AssetClass;
  symbol: string;
  price: number;
  unit: string;
  quoteCurrency: string;
  priceTime: string;
  source: string;
  /**
   * Gold only: the same quote stated in every unit it can be held in, keyed by
   * unit (`chỉ`, `lượng`, `gram`). `price`/`unit` above stay the one asked for,
   * so existing readers are unaffected; a form switching units reads across
   * this map instead of re-fetching. Absent for every other asset class, which
   * is quoted in the one unit it trades in.
   */
  unitPrices?: Record<string, number>;
}
