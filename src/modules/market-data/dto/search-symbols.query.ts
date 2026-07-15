import type { SymbolAssetClass } from '../providers/symbol-reference-provider.interface';

export interface SearchSymbolsQuery {
  /** Which class to search — required; only `stock` and `crypto` are supported. */
  assetClass?: SymbolAssetClass;
  /** Free-text query. Empty/absent → the curated default list for the class. */
  q?: string;
  /** Max results to return (default 20, capped). */
  limit?: string;
}
