export type DebtType =
  | 'family_loan'
  | 'friend_loan'
  | 'bank_loan'
  | 'consumer_finance'
  | 'mortgage'
  | 'credit_card'
  | 'installment'
  | 'other';

export type LenderType =
  | 'family'
  | 'friend'
  | 'bank'
  | 'credit_institution'
  | 'company'
  | 'other';

export type DebtStatus =
  | 'active'
  | 'paid_off'
  | 'paused'
  | 'overdue'
  | 'cancelled';

export interface Debt {
  id: string;
  householdId: string;
  name: string;
  debtType: DebtType;
  lenderType: LenderType;
  lenderName?: string;
  originalAmount: number;
  outstandingAmount: number;
  currency: string;
  borrowedAt?: string;
  expectedFinalDueDate?: string;
  status: DebtStatus;
  ownerMemberId?: string;
  receivedToAssetId?: string;
  paymentFrequency?: string;
  fixedPaymentAmount?: number;
  minimumPaymentAmount?: number;
  interestType?: string;
  interestCalculation?: string;
  interestRate?: number;
  note?: string;
}
