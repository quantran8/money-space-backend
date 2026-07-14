export type AssetValuationMethod =
  | 'manual'
  | 'market_price_api'
  | 'formula_calculated'
  | 'statement'
  | 'appraised'
  | 'other';

export type ConfidenceLevel = 'low' | 'medium' | 'high';

/**
 * One point in an asset's value history (table `asset_value_history`): the value
 * at a moment, plus how it was produced (method / confidence / lineage) and the
 * money event whose effect created it. A series of these is the asset's value
 * over time.
 */
export interface AssetValueHistory {
  id: string;
  assetId: string;
  householdId: string;
  valuationDate: string;
  value: number;
  currency: string;
  method: AssetValuationMethod;
  note?: string;
  // The money event whose effect produced this point — lets an event edit/delete
  // find and update/soft-delete exactly the record it created (see [[asset-valuation]]).
  moneyEventId?: string;
  // Lineage — how this number was produced (nullable; populated as sources exist).
  source?: string;
  confidenceLevel?: ConfidenceLevel;
  fxRateId?: string;
  calculationTermId?: string;
}
