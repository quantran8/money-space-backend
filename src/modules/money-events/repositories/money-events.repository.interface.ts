import type { Household } from '../../households/entities/household.entity';
import type { MoneyEvent } from '../entities/money-event.entity';

export const MONEY_EVENTS_REPOSITORY = Symbol('MONEY_EVENTS_REPOSITORY');

export interface MoneyEventsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  findMoneyEventsByHousehold(householdId: string): Promise<MoneyEvent[]>;
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
