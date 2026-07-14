export type MoneyEventType =
  | 'expense'
  | 'income'
  | 'transfer'
  | 'asset_purchase'
  | 'asset_sale'
  // A revaluation: the user re-priced an asset directly (manualValue, unitPrice,
  // quantity, term…). `neutral` — records why the value changed for history, but
  // moves no wallet and is excluded from income/expense reports. See [[asset-valuation]].
  | 'asset_update'
  | 'goal_contribution'
  | 'debt_update'
  | 'adjustment';

export type MoneyDirection = 'inflow' | 'outflow' | 'neutral';

export interface MoneyEvent {
  id: string;
  householdId: string;
  amount: number;
  /** Sale/purchase fee. 0 for every other event type. See asset-sale.md. */
  feeAmount: number;
  /**
   * Resolved sold quantity (market assets) / value (manual assets) for an
   * asset_sale, so an edit/cancel can restore the position exactly. Undefined
   * for non-sale events.
   */
  soldQuantity?: number;
  soldValue?: number;
  note: string;
  isoDate: string;
  type: MoneyEventType;
  category: string;
  direction: MoneyDirection;
  fromAssetId?: string;
  toAssetId?: string;
  upcomingPaymentId?: string;
  debtId?: string;
  financialGoalId?: string;
}
