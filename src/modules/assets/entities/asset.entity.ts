import type { CalculationTerm } from './calculation-term.entity';
import type { MarketPosition } from './market-position.entity';

export type AssetType =
  | 'cash'
  | 'bank_account'
  | 'saving_deposit'
  | 'bond'
  | 'gold'
  | 'stock'
  | 'fund'
  | 'crypto'
  | 'foreign_currency'
  | 'real_estate'
  | 'insurance'
  | 'loan_receivable'
  | 'certificate_of_deposit'
  | 'investment'
  | 'other';

export type AssetValuationMode =
  'manual' | 'market_priced' | 'formula_calculated';

export type AssetLiquidity =
  'usable_now' | 'not_immediately_usable' | 'long_term';

export type AssetClass =
  'gold' | 'crypto' | 'stock' | 'fund' | 'foreign_currency';

export type AssetStatus = 'active' | 'sold' | 'closed';

/**
 * Asset types that can be sold through the asset-sale flow. Market-priced ones
 * carry an `asset_market_positions` row (partial sale = reduce `quantity`);
 * `real_estate` / `investment` are manual (partial sale = reduce the stored
 * value). Wallets, deposits, insurance and `other` are excluded — see
 * [[asset-sale]] for the rationale.
 *
 * Lives on the entity rather than on `AssetsService` so the forecast's pure
 * what-if engine can read it without importing a Nest provider. Re-exported as
 * `AssetsService.SELLABLE_ASSET_TYPES`; both names are the same set.
 */
export const SELLABLE_ASSET_TYPES: ReadonlySet<AssetType> = new Set<AssetType>([
  'gold',
  'stock',
  'crypto',
  'fund',
  'foreign_currency',
  'bond',
  'real_estate',
  'investment',
]);

export interface Asset {
  id: string;
  householdId: string;
  name: string;
  type: AssetType;
  valuationMode: AssetValuationMode;
  liquidity: AssetLiquidity;
  /**
   * The household's explicit answer to "does this count towards flexible
   * money", or null for "follow the type". `liquidity` is derived from it —
   * see `liquidityForAsset`.
   */
  countsAsFlexible?: boolean | null;
  currency: string;
  note: string;
  status: AssetStatus;
  /**
   * When this asset's value was last established, as an ISO timestamp. NULL
   * means never — which the freshness rules report as `unknown`, not `stale`:
   * "we don't know" and "it's old" are different claims.
   */
  valueUpdatedAt?: string | null;
  /** Who is responsible for the money. Distinct from who entered the record. */
  holderMemberId?: string | null;
  soldAt?: string;
  /** Remaining floor/land area for a real-estate asset, in square metres. */
  areaSqm?: number;
  manualValue?: number;
  marketPosition?: MarketPosition;
  calculationTerm?: CalculationTerm;
}
