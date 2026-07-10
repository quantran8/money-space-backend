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
  upsertDebtTerms(debt: Debt): Promise<void>;
  upsertDebtInterestPeriods(debt: Debt): Promise<void>;
  unlinkDebtFromUpcomingPayments(debtId: string): Promise<void>;
  unlinkDebtFromMoneyEvents(debtId: string): Promise<void>;
}
