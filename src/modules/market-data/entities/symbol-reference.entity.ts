import type { AssetClass } from '../../assets/entities/asset.entity';

/**
 * One searchable market instrument surfaced to the asset-create flow. Only the
 * classes the price provider can quote are listed (`stock`, `crypto`); the
 * frontend uses `symbol` as the asset's position symbol and may prefill `unit`
 * and `quoteCurrency` from here.
 */
export interface SymbolReference {
  assetClass: Extract<AssetClass, 'stock' | 'crypto'>;
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
}
