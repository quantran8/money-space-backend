import type { Household } from '../../households/entities/household.entity';
import type { MoneyEvent } from '../entities/money-event.entity';

export const MONEY_EVENTS_REPOSITORY = Symbol('MONEY_EVENTS_REPOSITORY');

export interface MoneyEventFilter {
  /** `YYYY-MM` — restricts to events whose `eventDate` falls in that month. */
  month?: string;
  type?: string;
  category?: string;
  /** Hard cap on rows returned (already validated/clamped by the caller). */
  limit?: number;
}

export interface MoneyEventMonthSummary {
  recordedCount: number;
  totalIncome: number;
  totalOutcome: number;
}

export interface MoneyEventsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  findMoneyEventsByHousehold(householdId: string): Promise<MoneyEvent[]>;
  /**
   * Filtered + bounded list for the events page. Pushes the month/type/category
   * filters and the `limit` into SQL (served by
   * `@@index([householdId, eventDate(sort: Desc)])`) instead of fetching the
   * whole ledger and filtering in memory. `total` is the count of rows matching
   * the filter (before `limit`).
   */
  findMoneyEventsPage(
    householdId: string,
    filter: MoneyEventFilter,
  ): Promise<{ items: MoneyEvent[]; total: number }>;
  /**
   * Aggregate one month's thu/chi/net in a single grouped query, instead of
   * summing the whole ledger in memory. `recordedCount` counts every event in
   * the month (all directions); income/outcome sum only inflow/outflow.
   */
  summarizeMonth(
    householdId: string,
    month: string,
  ): Promise<MoneyEventMonthSummary>;
  findMoneyEventsByDebt(
    householdId: string,
    debtId: string,
  ): Promise<MoneyEvent[]>;
  findMoneyEventById(
    householdId: string,
    eventId: string,
  ): Promise<MoneyEvent | undefined>;
  insertMoneyEvent(event: MoneyEvent): Promise<void>;
  updateMoneyEvent(eventId: string, event: MoneyEvent): Promise<void>;
  deleteMoneyEvent(eventId: string): Promise<void>;
  /**
   * Bulk soft-delete every non-deleted money event linked to a debt in one
   * statement. The caller still reverses each event's wallet effects separately.
   */
  deleteMoneyEventsByDebt(householdId: string, debtId: string): Promise<void>;
  /**
   * Adjust a debt's `outstandingAmount` by `delta` (may be negative to reduce or
   * positive to raise), floored at 0, scoped to the household. A repayment
   * reduces it (negative delta); reversing that repayment on an edit/delete
   * raises it back (positive delta).
   */
  adjustDebtOutstanding(
    householdId: string,
    debtId: string,
    delta: number,
  ): Promise<void>;
  /**
   * The repayment terms a debt-linked event needs to decide its side effects:
   * the lender bucket (fixed-schedule lenders lock their events and never
   * rebalance) and the fixed installment amount (the baseline an over/under
   * payment is measured against). Undefined when the debt is absent/deleted.
   */
  findDebtRepaymentInfo(
    householdId: string,
    debtId: string,
  ): Promise<DebtRepaymentInfo | undefined>;
  /**
   * Rebalance the next unpaid upcoming payment of a `relative`/`other` debt by
   * `delta`: `nextAmount = max(0, nextAmount + delta)`. An overpayment passes a
   * negative delta (next installment shrinks); an underpayment passes a positive
   * delta (next installment grows). Total owed and the number of installments
   * are unchanged. No-op when the debt has no future unpaid installment.
   */
  adjustNextUnpaidPayment(
    householdId: string,
    debtId: string,
    afterDate: string,
    delta: number,
  ): Promise<void>;
}

/** Repayment terms of a debt, read by the events layer. */
export interface DebtRepaymentInfo {
  lenderType: 'relative' | 'bank_institution' | 'other';
  /** The fixed installment amount, or undefined when no schedule is set. */
  fixedPaymentAmount?: number;
}
