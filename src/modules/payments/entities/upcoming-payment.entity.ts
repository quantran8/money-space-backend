export type PaymentUiStatus = 'important' | 'normal' | 'pending';

export interface UpcomingPayment {
  id: string;
  householdId: string;
  name: string;
  amount: number;
  dueDate: string;
  owner: string;
  debtId?: string;
  status: PaymentUiStatus;
}
