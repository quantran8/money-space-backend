import type { AssetClass } from '../../assets/entities/asset.entity';

export interface GetQuoteQuery {
  /** Which class the symbol belongs to; picks the provider. */
  assetClass?: AssetClass;
  /** The ticker to price, e.g. `VNM`, `AAPL`, `BTC`. */
  symbol?: string;
  /** Venue, e.g. `HOSE`. Routes a VN listing to the VN provider. */
  market?: string;
  /** Currency to quote in; defaults per class (VND for VN equities). */
  quoteCurrency?: string;
}
