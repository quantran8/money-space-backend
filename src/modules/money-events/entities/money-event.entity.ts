export type MoneyEventType =
  | 'expense'
  | 'income'
  | 'transfer'
  | 'goal_contribution';

export type MoneyDirection = 'inflow' | 'outflow' | 'neutral';

export interface MoneyEvent {
  id: string;
  householdId: string;
  title: string;
  amount: number;
  note: string;
  isoDate: string;
  type: MoneyEventType;
  category: string;
  direction: MoneyDirection;
  fromAssetId?: string;
  toAssetId?: string;
  upcomingPaymentId?: string;
  financialGoalId?: string;
}
