import type { Household } from '../../households/entities/household.entity';
import type { UpcomingPayment } from '../entities/upcoming-payment.entity';

export const PAYMENTS_REPOSITORY = Symbol('PAYMENTS_REPOSITORY');

export interface PaymentsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  findUpcomingPaymentsByHousehold(householdId: string): Promise<UpcomingPayment[]>;
  findUpcomingPaymentById(householdId: string, paymentId: string): Promise<UpcomingPayment | undefined>;
  insertUpcomingPayment(payment: UpcomingPayment): Promise<void>;
  updateUpcomingPayment(paymentId: string, payment: UpcomingPayment): Promise<void>;
  deleteUpcomingPayment(paymentId: string): Promise<void>;
  unlinkUpcomingPaymentFromMoneyEvents(paymentId: string): Promise<void>;
}
