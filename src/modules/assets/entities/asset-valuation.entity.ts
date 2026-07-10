export interface AssetValuation {
  id: string;
  assetId: string;
  householdId: string;
  valuationDate: string;
  value: number;
  currency: string;
  method: 'manual' | 'market_price_api' | 'formula_calculated' | 'statement';
  note?: string;
}
