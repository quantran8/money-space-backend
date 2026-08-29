import { Injectable, NotFoundException } from '@nestjs/common';
import {
  mapAsset,
  mapFinancialGoal,
  mapGoalAssetAllocation,
  mapFxRate,
  mapHousehold,
  mapMoneyEvent,
  mapSnapshot,
  mapCashflowEvent,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { Asset } from '../../assets/entities/asset.entity';
import { SnapshotPoint } from '../entities/snapshot-point.entity';
import {
  FinancialGoal,
  GoalAssetAllocation,
} from '../../goals/entities/financial-goal.entity';
import { Household } from '../../households/entities/household.entity';
import { FxRate } from '../../market-data/entities/fx-rate.entity';
import { MoneyEvent } from '../../money-events/entities/money-event.entity';
import { CashflowEvent } from '../../cashflow-events/entities/cashflow-event.entity';
import { DashboardRepository } from './dashboard.repository.interface';

@Injectable()
export class PrismaDashboardRepository
  extends PrismaRepository
  implements DashboardRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
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

  async findAssetsByHousehold(householdId: string): Promise<Asset[]> {
    const assets = await this.prisma.asset.findMany({
      where: { householdId, deletedAt: null },
      include: {
        marketPositions: { where: { deletedAt: null }, take: 1 },
        calculationTerms: { where: { deletedAt: null }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });

    return assets.map((asset) =>
      mapAsset(asset, asset.marketPositions[0], asset.calculationTerms[0]),
    );
  }

  async getFxRates(): Promise<FxRate[]> {
    const rates = await this.findLatestFxRates();
    return rates.map((rate) => mapFxRate(rate));
  }

  async findCashflowEventsByHousehold(
    householdId: string,
  ): Promise<CashflowEvent[]> {
    const rows = await this.prisma.cashflowEvent.findMany({
      where: {
        householdId,
        deletedAt: null,
        // Only what still owes money — a completed/cancelled event is history.
        status: { notIn: ['completed', 'cancelled'] },
      },
      orderBy: { expectedDate: 'asc' },
    });

    return rows.map((row) => mapCashflowEvent(row));
  }

  async findFinancialGoalsByHousehold(
    householdId: string,
  ): Promise<FinancialGoal[]> {
    const goals = await this.prisma.financialGoal.findMany({
      where: { householdId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    return goals.map((goal) => mapFinancialGoal(goal));
  }

  async findGoalAllocationsByHousehold(
    householdId: string,
  ): Promise<GoalAssetAllocation[]> {
    const rows = await this.prisma.goalAssetAllocation.findMany({
      where: { householdId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => mapGoalAssetAllocation(row));
  }

  // The dashboard's "recent events" panel shows only a handful of the newest
  // events, so cap the read at a small top-N (index-backed on
  // householdId, eventDate DESC) instead of materializing the whole ledger.
  private static readonly RECENT_EVENTS_LIMIT = 10;
  // The net-worth trend chart plots the most recent window of snapshots; one
  // snapshot per day would otherwise grow the payload without bound.
  private static readonly ASSET_TREND_LIMIT = 90;

  async findMoneyEventsByHousehold(householdId: string): Promise<MoneyEvent[]> {
    const events = await this.prisma.moneyEvent.findMany({
      where: { householdId, deletedAt: null },
      orderBy: { eventDate: 'desc' },
      take: PrismaDashboardRepository.RECENT_EVENTS_LIMIT,
    });

    return events.map((event) => mapMoneyEvent(event));
  }

  async getSnapshotsByHousehold(householdId: string): Promise<SnapshotPoint[]> {
    // Fetch the newest N (index-backed on householdId, snapshotDate DESC), then
    // reverse to ascending — the trend chart expects oldest → newest.
    const snapshots = await this.prisma.snapshot.findMany({
      where: { householdId, deletedAt: null },
      orderBy: { snapshotDate: 'desc' },
      take: PrismaDashboardRepository.ASSET_TREND_LIMIT,
    });

    return snapshots.reverse().map((snapshot) => mapSnapshot(snapshot));
  }

  async getOutstandingDebtTotal(householdId: string): Promise<number> {
    const agg = await this.prisma.debt.aggregate({
      where: { householdId, deletedAt: null, status: 'active' },
      _sum: { outstandingAmount: true },
    });
    return Number(agg._sum.outstandingAmount ?? 0);
  }
}
