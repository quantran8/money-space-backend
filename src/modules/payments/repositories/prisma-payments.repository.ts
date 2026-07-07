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
    const household = await this.assertHousehold(payment.householdId);
    await this.prisma.upcomingPayment.create({
      data: {
        id: payment.id,
        householdId: payment.householdId,
        name: payment.name,
        amount: payment.amount,
        dueDate: this.toDate(payment.dueDate),
        ...toPaymentStatusFields(payment.status),
        ownerMemberId: this.asUuid(payment.owner),
        createdById: household.createdBy,
      } as any,
    });
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
