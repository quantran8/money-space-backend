import type { SymbolReference } from '../entities/symbol-reference.entity';

export const SYMBOL_REFERENCE_PROVIDER = Symbol('SYMBOL_REFERENCE_PROVIDER');

export type SymbolAssetClass = SymbolReference['assetClass'];

/**
 * Reference data for the asset-create symbol picker. Distinct from the quote
 * `PriceProvider`: this lists *which* instruments exist (for search + the
 * default list), it does not price them.
 */
export interface SymbolReferenceProvider {
  /**
   * The full reference list for a class, cached upstream. Empty when the
   * provider is not configured or the upstream call fails.
   */
  listSymbols(assetClass: SymbolAssetClass): Promise<SymbolReference[]>;
}
