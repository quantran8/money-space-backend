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
  /**
   * For gold, the unit the holding is counted in (`chỉ`, `lượng`, `gram`). The
   * quote comes back priced in it, so the caller never rescales a price itself.
   * Ignored by every other asset class; defaults to the dealers' own `lượng`.
   */
  unit?: string;
}
