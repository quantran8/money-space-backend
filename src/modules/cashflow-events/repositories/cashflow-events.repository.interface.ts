import type { Household } from '../../households/entities/household.entity';
import type { CashflowEvent } from '../entities/cashflow-event.entity';

export const CASHFLOW_EVENTS_REPOSITORY = Symbol('CASHFLOW_EVENTS_REPOSITORY');

export interface CashflowEventFilter {
  direction?: string;
  /** A concrete status, or `live` for everything that still owes money. */
  status?: string;
  requirement?: string;
  certainty?: string;
  /** Inclusive ISO bounds on `expectedDate`. */
  from?: string;
  to?: string;
  limit?: number;
}

export interface CashflowEventsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  findCashflowEventsByHousehold(householdId: string): Promise<CashflowEvent[]>;
  /**
   * Filtered + bounded list. Filters are pushed into SQL (served by
   * `@@index([householdId, expectedDate])` and friends) rather than fetching
   * every row and filtering in memory.
   */
  findCashflowEventsPage(
    householdId: string,
    filter: CashflowEventFilter,
  ): Promise<CashflowEvent[]>;
  /**
   * Every LIVE event that could contribute an occurrence to a forecast window.
   *
   * Deliberately reads a WIDER date range than the horizon: a recurring series
   * whose stored `expectedDate` is months in the past still produces
   * occurrences inside the window, and an overdue one still owes money today.
   * Excludes `private` records — they never enter shared calculations (§11).
   */
  findForecastCashflowEvents(householdId: string): Promise<CashflowEvent[]>;
  findCashflowEventById(
    householdId: string,
    eventId: string,
  ): Promise<CashflowEvent | undefined>;
  insertCashflowEvent(event: CashflowEvent): Promise<void>;
  insertCashflowEvents(events: CashflowEvent[]): Promise<void>;
  updateCashflowEvent(eventId: string, event: CashflowEvent): Promise<void>;
  deleteCashflowEvent(eventId: string): Promise<void>;
  unlinkCashflowEventFromMoneyEvents(eventId: string): Promise<void>;
  /**
   * Clear every reference to one asset from the household's events.
   *
   * Called when the asset is deleted. The events themselves stay: an expected
   * bill is a fact about money that still has to move, and it does not stop
   * being true because the wallet it was going to come out of was removed. Only
   * the pointer goes, so the household is asked to name a new wallet rather than
   * being shown one that no longer exists.
   *
   * Covers all three columns — planned, settlement, and last-completed — because
   * an asset can be referenced by any of them and a missed one is exactly the
   * dangling pointer this exists to prevent.
   */
  unlinkAssetFromCashflowEvents(
    householdId: string,
    assetId: string,
  ): Promise<void>;
  /**
   * Set `amount` on the still-open events for a debt due on/after `fromDate`
   * (an effective-from-now repayment-amount change). Past and completed ones
   * are left alone.
   */
  updateOpenCashflowEventAmountsByDebt(
    householdId: string,
    debtId: string,
    fromDate: string,
    newAmount: number,
  ): Promise<void>;
  /** Soft-delete still-open debt reminders, optionally from a date onward. */
  deleteOpenCashflowEventsByDebt(
    householdId: string,
    debtId: string,
    fromDate?: string,
  ): Promise<void>;
}
