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
  soldAt?: string;
  manualValue?: number;
  marketPosition?: MarketPosition;
  calculationTerm?: CalculationTerm;
}
