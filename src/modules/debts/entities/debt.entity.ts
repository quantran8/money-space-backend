/**
 * Who the household borrowed from — the single classification of a debt. Drives
 * the repayment rules (see memory/debts.md):
 *   - `bank_institution`: interest, term, and a fixed monthly payment are
 *     required; repayment money events are locked (can't be hand-edited).
 *   - `relative` / `other`: interest and a fixed term are optional; when the
 *     user sets a schedule, editing a repayment event rebalances the next
 *     unpaid installment by the over/under-payment.
 */
export type LenderType = 'relative' | 'bank_institution' | 'other';

/** Lenders whose repayment schedule is fixed and whose events are locked. */
export function isFixedScheduleLender(lenderType: LenderType): boolean {
  return lenderType === 'bank_institution';
}

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
