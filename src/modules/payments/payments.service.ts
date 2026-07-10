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
    let items =
      await this.paymentsRepository.findUpcomingPaymentsByHousehold(
        householdId,
      );

    if (query?.status) {
      items = items.filter((payment) => payment.status === query.status);
    }
    if (query?.limit) {
      const limit = Number(query.limit);
      if (Number.isFinite(limit) && limit > 0) {
        items = items.slice(0, limit);
      }
    }

    return {
      householdId,
      items: items.map((payment) => toPaymentCard(payment)),
      total: items.length,
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
