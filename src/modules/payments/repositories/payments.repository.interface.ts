import type { Household } from '../../households/entities/household.entity';
import type { UpcomingPayment } from '../entities/upcoming-payment.entity';

export const PAYMENTS_REPOSITORY = Symbol('PAYMENTS_REPOSITORY');

export interface UpcomingPaymentFilter {
  /** UI status (`normal` | `important` | `pending`) — translated to the DB
   * `status` + `attentionLevel` predicate inside the repository. */
  status?: string;
  /** Hard cap on rows returned (already validated/clamped by the caller). */
  limit?: number;
}

export interface PaymentsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  findUpcomingPaymentsByHousehold(
    householdId: string,
  ): Promise<UpcomingPayment[]>;
  /**
   * Filtered + bounded list for the payments page. Pushes the UI-status filter
   * and `limit` into SQL (served by `@@index([householdId, dueDate])`) instead
   * of fetching every payment and filtering in memory.
   */
  findUpcomingPaymentsPage(
    householdId: string,
    filter: UpcomingPaymentFilter,
  ): Promise<UpcomingPayment[]>;
  findUpcomingPaymentById(
    householdId: string,
    paymentId: string,
  ): Promise<UpcomingPayment | undefined>;
  insertUpcomingPayment(payment: UpcomingPayment): Promise<void>;
  insertUpcomingPayments(payments: UpcomingPayment[]): Promise<void>;
  updateUpcomingPayment(
    paymentId: string,
    payment: UpcomingPayment,
  ): Promise<void>;
  deleteUpcomingPayment(paymentId: string): Promise<void>;
  unlinkUpcomingPaymentFromMoneyEvents(paymentId: string): Promise<void>;
  /**
   * Set `amount` on the still-open reminders for a debt due on/after `fromDate`
   * (an effective-from-now repayment-amount change). Past + recorded ones stay.
   */
  updateUnpaidUpcomingPaymentAmountsByDebt(
    householdId: string,
    debtId: string,
    fromDate: string,
    newAmount: number,
  ): Promise<void>;
}
