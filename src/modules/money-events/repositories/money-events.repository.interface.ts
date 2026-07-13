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
   * Decrement a debt's `outstandingAmount` by `amount`, floored at 0, scoped to
   * the household. Used when a repayment event is recorded against a debt so the
   * remaining balance reflects the payment.
   */
  reduceDebtOutstanding(
    householdId: string,
    debtId: string,
    amount: number,
  ): Promise<void>;
}
