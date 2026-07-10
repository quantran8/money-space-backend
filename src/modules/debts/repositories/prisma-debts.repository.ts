import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  mapDebt,
  mapHousehold,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { Household } from '../../households/entities/household.entity';
import { Debt } from '../entities/debt.entity';
import { DebtsRepository } from './debts.repository.interface';

@Injectable()
export class PrismaDebtsRepository
  extends PrismaRepository
  implements DebtsRepository
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

  async findDebtsByHousehold(householdId: string): Promise<Debt[]> {
    const debts = await this.prisma.debt.findMany({
      where: { householdId, deletedAt: null },
      include: {
        terms: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        interestPeriods: {
          where: { deletedAt: null },
          orderBy: { startDate: 'desc' },
          take: 1,
        },
      },
      orderBy: [{ status: 'asc' }, { borrowedAt: 'desc' }],
    });

    return debts.map((debt) => mapDebt(debt, debt.terms[0], debt.interestPeriods[0]));
  }

  async findDebtById(
    householdId: string,
    debtId: string,
  ): Promise<Debt | undefined> {
    const debt = await this.prisma.debt.findFirst({
      where: { id: debtId, householdId, deletedAt: null },
      include: {
        terms: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        interestPeriods: {
          where: { deletedAt: null },
          orderBy: { startDate: 'desc' },
          take: 1,
        },
      },
    });

    return debt ? mapDebt(debt, debt.terms[0], debt.interestPeriods[0]) : undefined;
  }

  async insertDebt(debt: Debt): Promise<void> {
    const household = await this.assertHousehold(debt.householdId);
    await this.prisma.debt.create({
      data: {
        id: debt.id,
        householdId: debt.householdId,
        name: debt.name,
        debtType: debt.debtType,
        lenderType: debt.lenderType,
        lenderName: debt.lenderName,
        originalAmount: debt.originalAmount,
        outstandingAmount: debt.outstandingAmount,
        currency: debt.currency,
        borrowedAt: debt.borrowedAt ? this.toDate(debt.borrowedAt) : null,
        expectedFinalDueDate: debt.expectedFinalDueDate
          ? this.toDate(debt.expectedFinalDueDate)
          : null,
        status: debt.status,
        ownerMemberId: debt.ownerMemberId,
        receivedToAssetId: debt.receivedToAssetId,
        note: debt.note,
        createdById: household.createdBy,
      } as any,
    });
  }

  async updateDebt(debtId: string, debt: Debt): Promise<void> {
    await this.prisma.debt.updateMany({
      where: { id: debtId, householdId: debt.householdId, deletedAt: null },
      data: {
        name: debt.name,
        debtType: debt.debtType,
        lenderType: debt.lenderType,
        lenderName: debt.lenderName,
        originalAmount: debt.originalAmount,
        outstandingAmount: debt.outstandingAmount,
        currency: debt.currency,
        borrowedAt: debt.borrowedAt ? this.toDate(debt.borrowedAt) : null,
        expectedFinalDueDate: debt.expectedFinalDueDate
          ? this.toDate(debt.expectedFinalDueDate)
          : null,
        status: debt.status,
        ownerMemberId: debt.ownerMemberId,
        receivedToAssetId: debt.receivedToAssetId,
        note: debt.note,
      } as any,
    });
  }

  async deleteDebt(debtId: string): Promise<void> {
    const now = new Date();
    await this.prisma.debt.updateMany({
      where: { id: debtId },
      data: { deletedAt: now },
    });
    await this.prisma.debtTerm.updateMany({
      where: { debtId },
      data: { deletedAt: now },
    });
    await this.prisma.debtInterestPeriod.updateMany({
      where: { debtId },
      data: { deletedAt: now },
    });
  }

  async upsertDebtTerms(debt: Debt): Promise<void> {
    const existing = await this.prisma.debtTerm.findFirst({
      where: { debtId: debt.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const data = {
      householdId: debt.householdId,
      debtId: debt.id,
      repaymentType:
        debt.paymentFrequency && debt.paymentFrequency !== 'none'
          ? 'fixed_schedule'
          : 'flexible',
      principalPaymentType:
        debt.paymentFrequency && debt.paymentFrequency !== 'none'
          ? 'equal_payment'
          : 'flexible',
      paymentFrequency: debt.paymentFrequency ?? null,
      fixedPaymentAmount: debt.fixedPaymentAmount ?? null,
      minimumPaymentAmount: debt.minimumPaymentAmount ?? null,
      startDate: debt.borrowedAt ? this.toDate(debt.borrowedAt) : null,
      endDate: debt.expectedFinalDueDate
        ? this.toDate(debt.expectedFinalDueDate)
        : null,
      hasInterest: !!debt.interestType && debt.interestType !== 'none',
      interestType: (debt.interestType as any) ?? 'none',
      interestCalculation: (debt.interestCalculation as any) ?? null,
      gracePeriodMonths: null,
    };

    if (existing) {
      await this.prisma.debtTerm.update({
        where: { id: existing.id },
        data: data as any,
      });
      return;
    }

    await this.prisma.debtTerm.create({ data: data as any });
  }

  async upsertDebtInterestPeriods(debt: Debt): Promise<void> {
    if (debt.interestRate === undefined || debt.interestRate === null) {
      return;
    }

    const existing = await this.prisma.debtInterestPeriod.findFirst({
      where: { debtId: debt.id, deletedAt: null },
      orderBy: { startDate: 'desc' },
    });

    const data = {
      householdId: debt.householdId,
      debtId: debt.id,
      startDate: this.toDate(debt.borrowedAt ?? new Date().toISOString().slice(0, 10)),
      endDate: debt.expectedFinalDueDate
        ? this.toDate(debt.expectedFinalDueDate)
        : null,
      interestRate: debt.interestRate,
      rateType: 'fixed',
      note: debt.interestType ?? null,
    };

    if (existing) {
      await this.prisma.debtInterestPeriod.update({
        where: { id: existing.id },
        data: data as any,
      });
      return;
    }

    await this.prisma.debtInterestPeriod.create({ data: data as any });
  }

  async unlinkDebtFromUpcomingPayments(debtId: string): Promise<void> {
    await this.prisma.upcomingPayment.updateMany({
      where: { debtId },
      data: { debtId: null },
    });
  }

  async unlinkDebtFromMoneyEvents(debtId: string): Promise<void> {
    await this.prisma.moneyEvent.updateMany({
      where: { debtId },
      data: { debtId: null },
    });
  }
}
