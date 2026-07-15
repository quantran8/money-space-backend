import type { AssetClass } from '../../assets/entities/asset.entity';

/**
 * One quote the provider is asked to fetch. Built from the distinct set of
 * `asset_market_positions` across every household so the provider can batch all
 * supported symbols in a single upstream call.
 */
export interface SymbolRequest {
  assetClass: AssetClass;
  /** The position's symbol; quotes are matched back by (assetClass, symbol). */
  symbol: string;
  /**
   * Explicit provider ticker override (`asset_market_positions.price_source_symbol`).
   * When absent the provider derives its ticker from `symbol`.
   */
  providerSymbol?: string;
  /** Currency the position is denominated in; defaults to USD upstream. */
  quoteCurrency: string;
}
