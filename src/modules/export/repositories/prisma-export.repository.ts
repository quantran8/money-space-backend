import { Injectable, NotFoundException } from '@nestjs/common';
import { numberFromDb } from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import type {
  ExportAssetRow,
  ExportCashflowEventRow,
  ExportDebtRow,
  ExportGoalRow,
  ExportHousehold,
  ExportMoneyEventRow,
  ExportRepository,
} from './export.repository.interface';

/**
 * Soft-deleted rows are left out of every read: the export is what the
 * household currently has, not an audit trail. See `memory/data-export.md`.
 */
const LIVE = { deletedAt: null } as const;

@Injectable()
export class PrismaExportRepository
  extends PrismaRepository
  implements ExportRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async assertHousehold(householdId: string): Promise<ExportHousehold> {
    const household = await this.prisma.household.findFirst({
      where: { id: householdId, ...LIVE },
      select: { id: true, name: true, currency: true, createdAt: true },
    });
    if (!household) {
      throw new NotFoundException(`Household "${householdId}" was not found`);
    }
    return household;
  }

  async findAssets(householdId: string): Promise<ExportAssetRow[]> {
    const rows = await this.prisma.asset.findMany({
      where: { householdId, ...LIVE },
      orderBy: { createdAt: 'asc' },
      select: {
        name: true,
        type: true,
        valuationMode: true,
        currentValue: true,
        currency: true,
        liquidity: true,
        status: true,
        note: true,
        valueUpdatedAt: true,
        createdAt: true,
        // An asset holds at most one live position; `take: 1` keeps the join
        // from turning one asset into several rows in the file.
        marketPositions: {
          where: LIVE,
          take: 1,
          select: { symbol: true, quantity: true, unit: true },
        },
      },
    });

    return rows.map(({ marketPositions, ...asset }) => {
      const position = marketPositions[0];
      return {
        ...asset,
        currentValue: numberFromDb(asset.currentValue),
        symbol: position?.symbol ?? null,
        quantity:
          position?.quantity === undefined
            ? null
            : numberFromDb(position.quantity),
        unit: position?.unit ?? null,
      };
    });
  }

  async findMoneyEvents(householdId: string): Promise<ExportMoneyEventRow[]> {
    const rows = await this.prisma.moneyEvent.findMany({
      where: { householdId, ...LIVE },
      orderBy: { eventDate: 'asc' },
      select: {
        eventDate: true,
        eventType: true,
        direction: true,
        description: true,
        amount: true,
        feeAmount: true,
        currency: true,
        status: true,
        createdAt: true,
        category: { select: { label: true } },
        fromAsset: { select: { name: true } },
        toAsset: { select: { name: true } },
      },
    });

    return rows.map((row) => ({
      eventDate: row.eventDate,
      eventType: row.eventType,
      direction: row.direction,
      description: row.description,
      categoryName: row.category?.label ?? null,
      amount: numberFromDb(row.amount),
      feeAmount: numberFromDb(row.feeAmount),
      currency: row.currency,
      fromAssetName: row.fromAsset?.name ?? null,
      toAssetName: row.toAsset?.name ?? null,
      status: row.status,
      createdAt: row.createdAt,
    }));
  }

  async findCashflowEvents(
    householdId: string,
  ): Promise<ExportCashflowEventRow[]> {
    const rows = await this.prisma.cashflowEvent.findMany({
      where: { householdId, ...LIVE },
      orderBy: { expectedDate: 'asc' },
      select: {
        name: true,
        direction: true,
        amount: true,
        expectedDate: true,
        recurrence: true,
        recurrenceEndDate: true,
        requirement: true,
        certainty: true,
        status: true,
        note: true,
        category: { select: { label: true } },
      },
    });

    return rows.map((row) => ({
      name: row.name,
      direction: row.direction,
      amount: numberFromDb(row.amount),
      expectedDate: row.expectedDate,
      recurrence: row.recurrence,
      recurrenceEndDate: row.recurrenceEndDate,
      requirement: row.requirement,
      certainty: row.certainty,
      categoryName: row.category?.label ?? null,
      status: row.status,
      note: row.note,
    }));
  }

  async findGoals(householdId: string): Promise<ExportGoalRow[]> {
    const rows = await this.prisma.financialGoal.findMany({
      where: { householdId, ...LIVE },
      orderBy: { createdAt: 'asc' },
      select: {
        name: true,
        category: true,
        targetAmount: true,
        targetDate: true,
        priority: true,
        status: true,
        note: true,
        createdAt: true,
      },
    });

    return rows.map((row) => ({
      ...row,
      targetAmount: numberFromDb(row.targetAmount),
    }));
  }

  async findDebts(householdId: string): Promise<ExportDebtRow[]> {
    const rows = await this.prisma.debt.findMany({
      where: { householdId, ...LIVE },
      orderBy: { createdAt: 'asc' },
      select: {
        name: true,
        lenderType: true,
        lenderName: true,
        originalAmount: true,
        outstandingAmount: true,
        currency: true,
        borrowedAt: true,
        expectedFinalDueDate: true,
        status: true,
        note: true,
      },
    });

    return rows.map((row) => ({
      ...row,
      originalAmount: numberFromDb(row.originalAmount),
      outstandingAmount: numberFromDb(row.outstandingAmount),
    }));
  }
}
