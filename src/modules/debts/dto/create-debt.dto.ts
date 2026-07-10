import type {
  DebtInterestPeriod,
  DebtStatus,
  DebtType,
  LenderType,
} from '../entities/debt.entity';

export interface CreateDebtDto {
  name: string;
  debtType: DebtType;
  lenderType: LenderType;
  lenderName?: string;
  originalAmount: number;
  outstandingAmount: number;
  currency?: string;
  borrowedAt?: string;
  expectedFinalDueDate?: string;
  status?: DebtStatus;
  ownerMemberId?: string;
  receivedToAssetId?: string;
  paymentFrequency?: string;
  fixedPaymentAmount?: number;
  minimumPaymentAmount?: number;
  interestType?: string;
  interestCalculation?: string;
  interestRate?: number;
  /** Optional per-stage interest schedule; overrides `interestRate` when present. */
  interestPeriods?: DebtInterestPeriod[];
  note?: string;
}
