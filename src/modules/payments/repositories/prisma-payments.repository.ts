import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
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
    return randomUUID();
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
         status, attention_level, is_attention_needed,
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
        ${statusFields.isAttentionNeeded},
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

  async updateUpcomingPayment(
    paymentId: string,
    payment: UpcomingPayment,
  ): Promise<void> {
    await this.prisma.upcomingPayment.updateMany({
      where: { id: paymentId, householdId: payment.householdId, deletedAt: null },
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
}
