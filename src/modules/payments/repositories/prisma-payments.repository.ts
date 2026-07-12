import { Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '../../../common/utils/uuid';
import {
  mapHousehold,
  mapUpcomingPayment,
  toPaymentStatusFields,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { Household } from '../../households/entities/household.entity';
import { UpcomingPayment } from '../entities/upcoming-payment.entity';
import { PaymentsRepository } from './payments.repository.interface';

@Injectable()
export class PrismaPaymentsRepository
  extends PrismaRepository
  implements PaymentsRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  createId(_prefix: string): string {
    return uuidv7();
  }

  async assertHousehold(householdId: string): Promise<Household> {
    const household = await this.prisma.household.findFirst({
      where: { id: householdId, deletedAt: null },
    });

    if (!household) {
      throw new NotFoundException(`Household "${householdId}" was not found`);
    }

    return mapHousehold(household);
  }

  async findUpcomingPaymentsByHousehold(
    householdId: string,
  ): Promise<UpcomingPayment[]> {
    const payments = await this.prisma.upcomingPayment.findMany({
      where: { householdId, deletedAt: null },
      orderBy: { dueDate: 'asc' },
    });

    return payments.map((payment) => mapUpcomingPayment(payment));
  }

  async findUpcomingPaymentById(
    householdId: string,
    paymentId: string,
  ): Promise<UpcomingPayment | undefined> {
    const payment = await this.prisma.upcomingPayment.findFirst({
      where: { id: paymentId, householdId, deletedAt: null },
    });

    return payment ? mapUpcomingPayment(payment) : undefined;
  }

  async insertUpcomingPayment(payment: UpcomingPayment): Promise<void> {
    // Single round-trip: insert the payment while deriving `created_by` from the
    // household row in one statement. If the household doesn't exist (or is
    // soft-deleted) the SELECT yields no row, nothing is inserted, and we
    // surface a 404 — matching the previous assertHousehold behaviour.
    const dueDate = this.toDate(payment.dueDate);
    const ownerMemberId = this.asUuid(payment.owner);
    const statusFields = toPaymentStatusFields(payment.status);

    // `updated_at` is NOT NULL with no DB default — Prisma's @updatedAt fills it
    // on ORM writes, but a raw INSERT must set it explicitly.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO upcoming_payments
        (id, household_id, name, amount, due_date, debt_id,
         status, attention_level,
         owner_member_id, created_by, updated_at)
      SELECT
        ${payment.id}::uuid,
        h.id,
        ${payment.name},
        ${payment.amount}::numeric,
        ${dueDate}::date,
        ${payment.debtId ?? null}::uuid,
        ${statusFields.status}::"PaymentStatus",
        ${statusFields.attentionLevel}::"AttentionLevel",
        ${ownerMemberId}::uuid,
        h.created_by,
        now()
      FROM households h
      WHERE h.id = ${payment.householdId}::uuid
        AND h.deleted_at IS NULL
    `;

    if (inserted === 0) {
      throw new NotFoundException(
        `Household "${payment.householdId}" was not found`,
      );
    }
  }

  async insertUpcomingPayments(payments: UpcomingPayment[]): Promise<void> {
    // Bulk insert in a single round-trip (`createMany`), so generating a debt's
    // whole repayment schedule doesn't fire one query per installment — that
    // many sequential round-trips inside an interactive transaction blows its
    // timeout on a remote/pooled connection.
    if (payments.length === 0) {
      return;
    }

    // Every payment in one call belongs to the same household; resolve its
    // `created_by` once. Missing/soft-deleted household → 404, matching the
    // single-insert path.
    const householdId = payments[0].householdId;
    const household = await this.prisma.household.findFirst({
      where: { id: householdId, deletedAt: null },
      select: { createdById: true },
    });
    if (!household) {
      throw new NotFoundException(`Household "${householdId}" was not found`);
    }

    await this.prisma.upcomingPayment.createMany({
      data: payments.map((payment) => {
        const statusFields = toPaymentStatusFields(payment.status);
        return {
          id: payment.id,
          householdId: payment.householdId,
          name: payment.name,
          amount: payment.amount,
          dueDate: this.toDate(payment.dueDate),
          debtId: payment.debtId ?? null,
          status: statusFields.status,
          attentionLevel: statusFields.attentionLevel,
          ownerMemberId: this.asUuid(payment.owner),
          createdById: household.createdById,
        };
      }) as any,
    });
  }

  async updateUpcomingPayment(
    paymentId: string,
    payment: UpcomingPayment,
  ): Promise<void> {
    await this.prisma.upcomingPayment.updateMany({
      where: {
        id: paymentId,
        householdId: payment.householdId,
        deletedAt: null,
      },
      data: {
        name: payment.name,
        amount: payment.amount,
        dueDate: this.toDate(payment.dueDate),
        debtId: payment.debtId,
        ownerMemberId: this.asUuid(payment.owner),
        ...toPaymentStatusFields(payment.status),
      } as any,
    });
  }

  async deleteUpcomingPayment(paymentId: string): Promise<void> {
    await this.prisma.upcomingPayment.updateMany({
      where: { id: paymentId },
      data: { deletedAt: new Date() },
    });
  }

  async unlinkUpcomingPaymentFromMoneyEvents(paymentId: string): Promise<void> {
    await this.prisma.moneyEvent.updateMany({
      where: { upcomingPaymentId: paymentId },
      data: { upcomingPaymentId: null },
    });
  }

  async updateUnpaidUpcomingPaymentAmountsByDebt(
    householdId: string,
    debtId: string,
    fromDate: string,
    newAmount: number,
  ): Promise<void> {
    // An "effective-from-now" repayment-amount change touches only the future
    // reminders (dueDate >= fromDate) that are still open. Recorded repayments
    // are money events, not upcoming rows, so they are inherently untouched.
    await this.prisma.upcomingPayment.updateMany({
      where: {
        householdId,
        debtId,
        deletedAt: null,
        dueDate: { gte: this.toDate(fromDate) ?? undefined },
      },
      data: { amount: newAmount },
    });
  }
}
