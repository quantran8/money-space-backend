import type { Household } from '../../households/entities/household.entity';
import type { Debt } from '../entities/debt.entity';

export const DEBTS_REPOSITORY = Symbol('DEBTS_REPOSITORY');

export interface DebtsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  findDebtsByHousehold(householdId: string): Promise<Debt[]>;
  findDebtById(householdId: string, debtId: string): Promise<Debt | undefined>;
  insertDebt(debt: Debt): Promise<void>;
  updateDebt(debtId: string, debt: Debt): Promise<void>;
  deleteDebt(debtId: string): Promise<void>;
  upsertDebtInterestPeriods(debt: Debt): Promise<void>;
  deleteUpcomingPaymentsByDebt(debtId: string): Promise<void>;
  /**
   * Close the latest open interest period at `effectiveDate` — used to append a
   * new rate stage from that date without wiping the historical stages.
   */
  closeLatestInterestPeriodAt(
    debtId: string,
    effectiveDate: string,
  ): Promise<void>;
  /** Append one interest-rate stage (does not touch existing stages). */
  appendInterestPeriod(
    householdId: string,
    debtId: string,
    row: {
      startDate: string;
      endDate: string | null;
      interestRate: number;
      months?: number;
    },
  ): Promise<void>;
  /**
   * Write an audit-log row for a debt change. The actor is resolved from the
   * household owner (`households.created_by`) since debt endpoints carry no
   * request user.
   */
  writeAuditLog(
    householdId: string,
    entry: {
      action: string;
      entityType: string;
      entityId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void>;
}
