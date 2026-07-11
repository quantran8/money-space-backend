export type MoneyEventType =
  | 'expense'
  | 'income'
  | 'transfer'
  | 'asset_purchase'
  | 'asset_sale'
  | 'goal_contribution'
  | 'debt_update'
  | 'adjustment';

export type MoneyDirection = 'inflow' | 'outflow' | 'neutral';

export interface MoneyEvent {
  id: string;
  householdId: string;
  title: string;
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
