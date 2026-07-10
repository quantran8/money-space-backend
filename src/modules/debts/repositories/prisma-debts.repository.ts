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
          orderBy: { startDate: 'asc' },
        },
      },
      orderBy: [{ status: 'asc' }, { borrowedAt: 'desc' }],
    });

    return debts.map((debt) =>
      mapDebt(
        debt,
        debt.terms[0],
        debt.interestPeriods[0],
        debt.interestPeriods,
      ),
    );
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
          orderBy: { startDate: 'asc' },
        },
      },
    });

    return debt
      ? mapDebt(
          debt,
          debt.terms[0],
          debt.interestPeriods[0],
          debt.interestPeriods,
        )
      : undefined;
  }

  async insertDebt(debt: Debt): Promise<void> {
    // Single round-trip: insert the debt while deriving `created_by` from the
    // household row in one statement. If the household doesn't exist (or is
    // soft-deleted) the SELECT yields no row, nothing is inserted, and we
    // surface a 404 — matching the previous assertHousehold behaviour.
    const borrowedAt = debt.borrowedAt ? this.toDate(debt.borrowedAt) : null;
    const expectedFinalDueDate = debt.expectedFinalDueDate
      ? this.toDate(debt.expectedFinalDueDate)
      : null;

    // Prisma's @updatedAt fills `updated_at` on ORM create/update writes but
    // does NOT apply to raw SQL, so set it explicitly to now() to mirror the
    // previous debt.create behaviour.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO debts
        (id, household_id, name, debt_type, lender_type, lender_name,
         original_amount, outstanding_amount, currency, borrowed_at,
         expected_final_due_date, status, owner_member_id, received_to_asset_id,
         note, created_by, updated_at)
      SELECT
        ${debt.id}::uuid,
        h.id,
        ${debt.name},
        ${debt.debtType}::"DebtType",
        ${debt.lenderType}::"LenderType",
        ${debt.lenderName ?? null},
        ${debt.originalAmount}::numeric,
        ${debt.outstandingAmount}::numeric,
        ${debt.currency},
        ${borrowedAt}::date,
        ${expectedFinalDueDate}::date,
        ${debt.status}::"DebtStatus",
        ${debt.ownerMemberId ?? null}::uuid,
        ${debt.receivedToAssetId ?? null}::uuid,
        ${debt.note ?? null},
        h.created_by,
        now()
      FROM households h
      WHERE h.id = ${debt.householdId}::uuid
        AND h.deleted_at IS NULL
    `;

    if (inserted === 0) {
      throw new NotFoundException(
        `Household "${debt.householdId}" was not found`,
      );
    }
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

  private normalizeInterestType(
    value: string | null | undefined,
  ): 'none' | 'fixed' | 'floating' | 'staged' {
    const allowed = ['none', 'fixed', 'floating', 'staged'] as const;
    if (value && (allowed as readonly string[]).includes(value)) {
      return value as (typeof allowed)[number];
    }
    // Free-form labels (e.g. "9.2%/năm · reducing balance") map to `fixed`
    // when interest is present, otherwise `none`.
    return value && value !== 'none' ? 'fixed' : 'none';
  }

  private normalizeInterestCalculation(
    value: string | null | undefined,
  ): 'simple_interest' | 'reducing_balance' | 'flat_rate' | 'custom' | null {
    const allowed = [
      'simple_interest',
      'reducing_balance',
      'flat_rate',
      'custom',
    ] as const;
    if (value && (allowed as readonly string[]).includes(value)) {
      return value as (typeof allowed)[number];
    }
    return null;
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
      interestType: this.normalizeInterestType(debt.interestType),
      interestCalculation: this.normalizeInterestCalculation(
        debt.interestCalculation,
      ),
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

  /** Encode a stage length (months) so it round-trips via the row's `note`. */
  private encodePeriodNote(months?: number): string | null {
    return months && months > 0 ? `months:${months}` : null;
  }

  /** Add `months` calendar months to an ISO date, returning a Date. */
  private addMonths(isoDate: string, months: number): Date {
    const base = new Date(`${isoDate}T00:00:00.000Z`);
    base.setUTCMonth(base.getUTCMonth() + months);
    return base;
  }

  /**
   * Replace a debt's interest schedule. Prefers the full `interestPeriods`
   * array (each stage becomes its own `debt_interest_periods` row); falls back
   * to a single row derived from `interestRate` for backward compatibility.
   *
   * Existing rows are soft-deleted first so editing the number/order of stages
   * never leaves stale rows behind.
   */
  async upsertDebtInterestPeriods(debt: Debt): Promise<void> {
    const hasStages =
      Array.isArray(debt.interestPeriods) && debt.interestPeriods.length > 0;
    const hasLegacyRate =
      debt.interestRate !== undefined && debt.interestRate !== null;
    if (!hasStages && !hasLegacyRate) {
      return;
    }

    const start = debt.borrowedAt ?? new Date().toISOString().slice(0, 10);

    // Build the rows to insert.
    let rows: Array<{
      startDate: Date | null;
      endDate: Date | null;
      interestRate: number;
      note: string | null;
    }>;

    if (hasStages) {
      let cursorIso = start;
      rows = debt.interestPeriods!.map((period, index) => {
        const isLast = index === debt.interestPeriods!.length - 1;
        const startDate = this.toDate(cursorIso);
        let endDate: Date | null;
        if (period.months && period.months > 0) {
          const next = this.addMonths(cursorIso, period.months);
          endDate = next;
          cursorIso = next.toISOString().slice(0, 10);
        } else {
          // Open-ended stage (usually the last): run to the loan's due date.
          endDate = debt.expectedFinalDueDate
            ? this.toDate(debt.expectedFinalDueDate)
            : null;
        }
        // The very last stage always extends to the due date if known.
        if (isLast && debt.expectedFinalDueDate) {
          endDate = this.toDate(debt.expectedFinalDueDate);
        }
        return {
          startDate,
          endDate,
          interestRate: period.interestRate,
          note: this.encodePeriodNote(period.months),
        };
      });
    } else {
      rows = [
        {
          startDate: this.toDate(start),
          endDate: debt.expectedFinalDueDate
            ? this.toDate(debt.expectedFinalDueDate)
            : null,
          interestRate: debt.interestRate!,
          note: null,
        },
      ];
    }

    await this.runInTransaction(async (tx) => {
      await tx.debtInterestPeriod.updateMany({
        where: { debtId: debt.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await tx.debtInterestPeriod.createMany({
        data: rows.map((row) => ({
          householdId: debt.householdId,
          debtId: debt.id,
          startDate: row.startDate,
          endDate: row.endDate,
          interestRate: row.interestRate,
          rateType: 'fixed',
          note: row.note,
        })) as any,
      });
    });
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
