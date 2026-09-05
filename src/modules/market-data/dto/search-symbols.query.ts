import type { SymbolAssetClass } from '../providers/symbol-reference-provider.interface';

export interface SearchSymbolsQuery {
  /** Which class to search — required; only `stock` and `crypto` are supported. */
  assetClass?: SymbolAssetClass;
  /** Free-text query. Empty/absent → the class's default list (VN30 for stock). */
  q?: string;
  /** Max results to return (default 30 — the whole VN30 — capped at 50). */
  limit?: string;
}
