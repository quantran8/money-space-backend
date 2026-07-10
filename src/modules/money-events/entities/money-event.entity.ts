export type MoneyEventType =
  'expense' | 'income' | 'transfer' | 'goal_contribution' | 'debt_update';

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
  debtId?: string;
  financialGoalId?: string;
}
