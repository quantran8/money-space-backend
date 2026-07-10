import type { PaymentUiStatus } from '../entities/upcoming-payment.entity';

export interface CreateUpcomingPaymentDto {
  name: string;
  amount: number;
  dueDate: string;
  owner?: string;
  debtId?: string;
  status: PaymentUiStatus;
}
