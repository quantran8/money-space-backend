import type { FinancialNature } from '../../../common/utils/shared-calculation';
import type { VisibilityLevel } from '../../../common/utils/money-space.utils';
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

export interface Asset {
  id: string;
  householdId: string;
  name: string;
  type: AssetType;
  valuationMode: AssetValuationMode;
  liquidity: AssetLiquidity;
  currency: string;
  note: string;
  status: AssetStatus;
  /**
   * When this asset's value was last established, as an ISO timestamp. NULL
   * means never — which the freshness rules report as `unknown`, not `stale`:
   * "we don't know" and "it's old" are different claims.
   */
  valueUpdatedAt?: string | null;
  /** Whose money this fundamentally is (§11). Pairs with `visibilityLevel`. */
  financialNature?: FinancialNature;
  visibilityLevel?: VisibilityLevel;
  /** Who holds it — distinct from who entered it and who owns its privacy. */
  holderMemberId?: string | null;
  privacyOwnerMemberId?: string | null;
  soldAt?: string;
  /** Remaining floor/land area for a real-estate asset, in square metres. */
  areaSqm?: number;
  manualValue?: number;
  marketPosition?: MarketPosition;
  calculationTerm?: CalculationTerm;
}
