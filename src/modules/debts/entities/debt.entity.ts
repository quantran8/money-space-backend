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
  'family' | 'friend' | 'bank' | 'credit_institution' | 'company' | 'other';

export type DebtStatus =
  'active' | 'paid_off' | 'paused' | 'overdue' | 'cancelled';

/**
 * One interest stage of a debt. Persisted as a row in `debt_interest_periods`.
 * `months` is the stage length relative to `startDate`; it is stored in the
 * row's `note` so the UI can round-trip the exact stage the user entered
 * without inferring it back from the date range.
 */
export interface DebtInterestPeriod {
  /** Annual interest rate in percent, e.g. 9.2. */
  interestRate: number;
  /** ISO date (yyyy-mm-dd) the stage starts. */
  startDate?: string;
  /** ISO date (yyyy-mm-dd) the stage ends. */
  endDate?: string;
  /** Stage length in months; null/undefined means "remaining term". */
  months?: number;
}

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
  /** Averaged annual rate across stages, kept for backward compatibility. */
  interestRate?: number;
  /** Full set of interest stages, ordered by start date. */
  interestPeriods?: DebtInterestPeriod[];
  note?: string;
}
