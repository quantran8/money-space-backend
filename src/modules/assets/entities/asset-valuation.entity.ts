export type AssetValuationMethod =
  | 'manual'
  | 'market_price_api'
  | 'formula_calculated'
  | 'statement'
  | 'appraised'
  | 'other';

export type ConfidenceLevel = 'low' | 'medium' | 'high';

export interface AssetValuation {
  id: string;
  assetId: string;
  householdId: string;
  valuationDate: string;
  value: number;
  currency: string;
  method: AssetValuationMethod;
  note?: string;
  // Lineage — how this number was produced (nullable; populated as sources exist).
  source?: string;
  confidenceLevel?: ConfidenceLevel;
  marketPriceId?: string;
  fxRateId?: string;
  calculationTermId?: string;
}
