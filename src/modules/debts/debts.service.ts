import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import type { CreateDebtDto } from './dto/create-debt.dto';
import type { ListDebtsQuery } from './dto/list-debts.query';
import type { UpdateDebtDto } from './dto/update-debt.dto';
import { Debt } from './entities/debt.entity';
import { DEBTS_REPOSITORY } from './repositories/debts.repository.interface';
import type { DebtsRepository } from './repositories/debts.repository.interface';

@Injectable()
export class DebtsService {
  constructor(
    @Inject(DEBTS_REPOSITORY)
    private readonly debtsRepository: DebtsRepository,
    private readonly prisma: PrismaService,
  ) {}

  async listDebts(householdId: string, query?: ListDebtsQuery) {
    await this.debtsRepository.assertHousehold(householdId);
    let items = await this.debtsRepository.findDebtsByHousehold(householdId);

    if (query?.status) {
      items = items.filter((debt) => debt.status === query.status);
    }
    if (query?.limit) {
      const limit = Number(query.limit);
      if (Number.isFinite(limit) && limit > 0) {
        items = items.slice(0, limit);
      }
    }

    return {
      householdId,
      items,
      total: items.length,
    };
  }

  async getDebt(householdId: string, debtId: string) {
    return this.ensureDebt(householdId, debtId);
  }

  async createDebt(householdId: string, payload: CreateDebtDto) {
    // `insertDebt` asserts the household exists (and needs its row to resolve
    // `createdById`), so we don't assert it a second time here.
    const debt: Debt = {
      id: this.debtsRepository.createId('debt'),
      householdId,
      name: payload.name.trim(),
      debtType: payload.debtType,
      lenderType: payload.lenderType,
      lenderName: payload.lenderName?.trim(),
      originalAmount: payload.originalAmount,
      outstandingAmount: payload.outstandingAmount,
      currency: payload.currency?.trim() || 'VND',
      borrowedAt: payload.borrowedAt,
      expectedFinalDueDate: payload.expectedFinalDueDate,
      status: payload.status ?? 'active',
      ownerMemberId: payload.ownerMemberId,
      receivedToAssetId: payload.receivedToAssetId,
      paymentFrequency: payload.paymentFrequency,
      fixedPaymentAmount: payload.fixedPaymentAmount,
      minimumPaymentAmount: payload.minimumPaymentAmount,
      interestType: payload.interestType,
      interestCalculation: payload.interestCalculation,
      interestRate: payload.interestRate,
      interestPeriods: payload.interestPeriods,
      note: payload.note?.trim(),
    };

    // All writes for a debt (the debt row + its terms + interest periods) must
    // succeed or fail together, so run them in one transaction. Statements on a
    // single transaction run sequentially — one connection, no concurrent
    // `Promise.all` on the shared `tx`.
    await this.prisma.runInTransaction(async () => {
      await this.debtsRepository.insertDebt(debt);
      await this.debtsRepository.upsertDebtTerms(debt);
      await this.debtsRepository.upsertDebtInterestPeriods(debt);
    });
    return debt;
  }

  async updateDebt(
    householdId: string,
    debtId: string,
    payload: UpdateDebtDto,
  ) {
    const debt = await this.ensureDebt(householdId, debtId);
    const next: Debt = {
      ...debt,
      ...payload,
      id: debt.id,
      householdId: debt.householdId,
      name: payload.name?.trim() ?? debt.name,
      lenderName: payload.lenderName?.trim() ?? debt.lenderName,
      currency: payload.currency?.trim() ?? debt.currency,
      note: payload.note?.trim() ?? debt.note,
      originalAmount: payload.originalAmount ?? debt.originalAmount,
      outstandingAmount: payload.outstandingAmount ?? debt.outstandingAmount,
      debtType: payload.debtType ?? debt.debtType,
      lenderType: payload.lenderType ?? debt.lenderType,
      borrowedAt: payload.borrowedAt ?? debt.borrowedAt,
      expectedFinalDueDate:
        payload.expectedFinalDueDate ?? debt.expectedFinalDueDate,
      status: payload.status ?? debt.status,
    };

    // The debt row and its terms / interest periods update atomically.
    await this.prisma.runInTransaction(async () => {
      await this.debtsRepository.updateDebt(debtId, next);
      await this.debtsRepository.upsertDebtTerms(next);
      await this.debtsRepository.upsertDebtInterestPeriods(next);
    });
    return next;
  }

  async deleteDebt(householdId: string, debtId: string) {
    await this.ensureDebt(householdId, debtId);
    // The soft-delete and the two unlinks must all land or none: run them in
    // one transaction (sequentially, since they share the transaction's
    // connection).
    await this.prisma.runInTransaction(async () => {
      await this.debtsRepository.deleteDebt(debtId);
      await this.debtsRepository.unlinkDebtFromUpcomingPayments(debtId);
      await this.debtsRepository.unlinkDebtFromMoneyEvents(debtId);
    });
    return {
      deleted: true,
      debtId,
    };
  }

  private async ensureDebt(householdId: string, debtId: string) {
    // `findDebtById` filters by { id, householdId, deletedAt: null }, so it
    // already returns undefined when the debt (or its household) is absent —
    // the separate assertHousehold before it was a wasted round-trip.
    const debt = await this.debtsRepository.findDebtById(householdId, debtId);
    if (!debt) {
      throw new NotFoundException(`Debt "${debtId}" was not found`);
    }
    return debt;
  }
}
