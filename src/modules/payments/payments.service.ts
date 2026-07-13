import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import { UpcomingPayment } from './entities/upcoming-payment.entity';
import {
  normalizePaymentStatus,
  toPaymentCard,
} from '../../common/utils/money-space.utils';
import type { CreateUpcomingPaymentDto } from './dto/create-upcoming-payment.dto';
import type { ListUpcomingPaymentsQuery } from './dto/list-upcoming-payments.query';
import type { UpdateUpcomingPaymentDto } from './dto/update-upcoming-payment.dto';
import { PAYMENTS_REPOSITORY } from './repositories/payments.repository.interface';
import type { PaymentsRepository } from './repositories/payments.repository.interface';

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(PAYMENTS_REPOSITORY)
    private readonly paymentsRepository: PaymentsRepository,
    private readonly prisma: PrismaService,
  ) {}

  async listUpcomingPayments(
    householdId: string,
    query?: ListUpcomingPaymentsQuery,
  ) {
    await this.paymentsRepository.assertHousehold(householdId);

    // Status + limit are pushed into SQL (index-backed on householdId, dueDate)
    // instead of fetching every payment and filtering in memory. `total`
    // preserves the previous `items.length` semantics (count of returned rows).
    let limit: number | undefined;
    if (query?.limit) {
      const parsed = Number(query.limit);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
    }

    const items = await this.paymentsRepository.findUpcomingPaymentsPage(
      householdId,
      { status: query?.status, limit },
    );

    const cards = items.map((payment) => toPaymentCard(payment));
    return {
      householdId,
      items: cards,
      total: cards.length,
    };
  }

  async getUpcomingPayment(householdId: string, paymentId: string) {
    return toPaymentCard(
      await this.ensureUpcomingPayment(householdId, paymentId),
    );
  }

  async createUpcomingPayment(
    householdId: string,
    payload: CreateUpcomingPaymentDto,
  ) {
    const payment: UpcomingPayment = {
      id: this.paymentsRepository.createId('payment'),
      householdId,
      name: payload.name.trim(),
      amount: payload.amount,
      dueDate: payload.dueDate,
      owner: payload.owner ?? 'Chua phan cong',
      debtId: payload.debtId,
      status: normalizePaymentStatus(payload.status),
    };

    await this.paymentsRepository.insertUpcomingPayment(payment);
    return toPaymentCard(payment);
  }

  async createUpcomingPayments(
    householdId: string,
    payloads: CreateUpcomingPaymentDto[],
  ) {
    // Bulk create (one round-trip) for callers that generate many payments at
    // once — e.g. a debt's repayment schedule. Avoids a per-item round-trip
    // that would blow an interactive transaction's timeout on a pooled DB.
    const payments: UpcomingPayment[] = payloads.map((payload) => ({
      id: this.paymentsRepository.createId('payment'),
      householdId,
      name: payload.name.trim(),
      amount: payload.amount,
      dueDate: payload.dueDate,
      owner: payload.owner ?? 'Chua phan cong',
      debtId: payload.debtId,
      status: normalizePaymentStatus(payload.status),
    }));

    await this.paymentsRepository.insertUpcomingPayments(payments);
    return payments.map((payment) => toPaymentCard(payment));
  }

  async updateUpcomingPayment(
    householdId: string,
    paymentId: string,
    payload: UpdateUpcomingPaymentDto,
  ) {
    const payment = await this.ensureUpcomingPayment(householdId, paymentId);
    const next: UpcomingPayment = {
      ...payment,
      ...payload,
      id: payment.id,
      householdId: payment.householdId,
      name: payload.name?.trim() ?? payment.name,
      amount: payload.amount ?? payment.amount,
      dueDate: payload.dueDate ?? payment.dueDate,
      owner: payload.owner ?? payment.owner,
      debtId: payload.debtId ?? payment.debtId,
      status: normalizePaymentStatus(payload.status ?? payment.status),
    };

    await this.paymentsRepository.updateUpcomingPayment(paymentId, next);
    return toPaymentCard(next);
  }

  async deleteUpcomingPayment(householdId: string, paymentId: string) {
    await this.ensureUpcomingPayment(householdId, paymentId);
    // The soft-delete and the money-event unlink must land together.
    await this.prisma.runInTransaction(async () => {
      await this.paymentsRepository.deleteUpcomingPayment(paymentId);
      await this.paymentsRepository.unlinkUpcomingPaymentFromMoneyEvents(
        paymentId,
      );
    });
    return {
      deleted: true,
      paymentId,
    };
  }

  /**
   * Effective-from-now repayment-amount change for a debt: set `amount` on the
   * still-open reminders due on/after `fromDate`. Passthrough so `DebtsService`
   * (which injects this service, not the repo) can reach it inside its own
   * transaction. See memory/debts.md.
   */
  async updateUnpaidUpcomingPaymentAmounts(
    householdId: string,
    debtId: string,
    fromDate: string,
    newAmount: number,
  ) {
    await this.paymentsRepository.updateUnpaidUpcomingPaymentAmountsByDebt(
      householdId,
      debtId,
      fromDate,
      newAmount,
    );
  }

  private async ensureUpcomingPayment(householdId: string, paymentId: string) {
    const payment = await this.paymentsRepository.findUpcomingPaymentById(
      householdId,
      paymentId,
    );
    if (!payment) {
      throw new NotFoundException(
        `Upcoming payment "${paymentId}" was not found`,
      );
    }
    return payment;
  }
}
