import type { AssetClass } from '../../assets/entities/asset.entity';

/**
 * One searchable market instrument surfaced to the asset-create flow.
 *
 * Covers every market-priced class the app can offer a real list for:
 * `stock` and `crypto` (full provider listings), plus `gold` and
 * `foreign_currency` (short curated lists — the products and currencies
 * Vietnamese households actually hold). The frontend uses `symbol` as the
 * asset's position symbol and may prefill `unit` and `quoteCurrency` from here.
 */
export interface SymbolReference {
  assetClass: Extract<
    AssetClass,
    'stock' | 'crypto' | 'gold' | 'foreign_currency'
  >;
  /** Ticker used both for display and as the position symbol (e.g. AAPL, BTC). */
  symbol: string;
  /** Human-readable instrument name (e.g. "Apple Inc", "Bitcoin"). */
  name: string;
  /** Exchange / venue (stock) or empty for crypto. */
  exchange: string;
  /** Currency the instrument is quoted in upstream (e.g. USD). */
  currency: string;
  /** Suggested position unit ("cp" for stock, "coin" for crypto). */
  unit: string;
  /**
   * VN30 constituent. Only VN equities carry it; it drives the stock picker's
   * default list, so a source that cannot tell simply leaves it unset.
   */
  vn30?: boolean;
}
