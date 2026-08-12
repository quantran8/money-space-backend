import { Injectable, NotFoundException } from '@nestjs/common';
import {
  mapAsset,
  mapCashflowEvent,
  mapHousehold,
  numberFromDb,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { addDaysIso, todayInTimeZone } from '../../../common/utils/clock';
import {
  SHARED_CALCULATION_ASSET_WHERE,
  SHARED_CALCULATION_VISIBILITY_WHERE,
} from '../../../common/utils/shared-calculation';
import { computeCurrentValue } from '../../../common/utils/money-space.utils';
import { Household } from '../../households/entities/household.entity';
import type {
  ForecastCashflowEvent,
  ForecastLiquidSource,
  ForecastProtectedReserve,
} from '../domain/forecast.types';
import {
  ForecastBundle,
  ForecastRepository,
} from './forecast.repository.interface';

/**
 * How far back to read cashflow events.
 *
 * A monthly series whose stored `expectedDate` is months old still produces
 * occurrences inside today's window, and an overdue bill still has to come out
 * of today's cash — so filtering to `expectedDate >= today` would silently drop
 * real obligations. A year covers every supported cadence.
 */
const LOOKBACK_DAYS = 400;
/** Longest supported horizon (90 days) plus slack. */
const LOOKAHEAD_DAYS = 120;

@Injectable()
export class PrismaForecastRepository
  extends PrismaRepository
  implements ForecastRepository
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

  async loadForecastBundle(householdId: string): Promise<ForecastBundle> {
    const today = todayInTimeZone();

    // Three queries in parallel. Deliberately does NOT go through AssetsService:
    // that would make ForecastModule depend on AssetsModule and form a cycle.
    // The same trick the snapshots repository uses.
    const [assetRows, eventRows, reserveRows, pricing] = await Promise.all([
      this.prisma.asset.findMany({
        where: {
          householdId,
          deletedAt: null,
          status: 'active',
          // Private / personal-private money never enters shared calculations
          // (§11). Filtered here so the hot path never loads it; the pure
          // engine re-asserts the same rule.
          ...SHARED_CALCULATION_ASSET_WHERE,
        } as never,
        include: {
          marketPositions: { where: { deletedAt: null }, take: 1 },
          calculationTerms: { where: { deletedAt: null }, take: 1 },
        },
      }),
      this.prisma.cashflowEvent.findMany({
        where: {
          householdId,
          deletedAt: null,
          status: { notIn: ['completed', 'cancelled'] },
          ...SHARED_CALCULATION_VISIBILITY_WHERE,
          expectedDate: {
            gte: this.toDate(addDaysIso(today, -LOOKBACK_DAYS)) ?? undefined,
            lte: this.toDate(addDaysIso(today, LOOKAHEAD_DAYS)) ?? undefined,
          },
        } as never,
        orderBy: { expectedDate: 'asc' },
      }),
      this.prisma.protectedReserve.findMany({
        where: { householdId, deletedAt: null },
      }),
      this.loadPricing(),
    ]);

    const assets: ForecastLiquidSource[] = assetRows.map((row) => {
      const withRelations = row as unknown as {
        marketPositions: Record<string, unknown>[];
        calculationTerms: Record<string, unknown>[];
      };
      const asset = mapAsset(
        row,
        withRelations.marketPositions[0],
        withRelations.calculationTerms[0],
      );
      return {
        assetId: asset.id,
        name: asset.name,
        value: computeCurrentValue(
          asset,
          pricing.marketPrices,
          pricing.fxRates,
          today,
        ),
        liquidity: asset.liquidity,
        // Read the REAL values. The snapshot repository's `getActiveAssetLines`
        // hardcodes `visibilityLevel: 'detail'`; reusing that here would make
        // the privacy filter silently pass everything.
        financialNature:
          (row as never as { financialNature: ForecastLiquidSource['financialNature'] })
            .financialNature ?? 'household',
        visibilityLevel:
          (row as never as { visibilityLevel: ForecastLiquidSource['visibilityLevel'] })
            .visibilityLevel ?? 'detail',
        valueUpdatedAt:
          (row as never as { valueUpdatedAt: Date | null }).valueUpdatedAt
            ?.toISOString()
            .slice(0, 10) ?? null,
      };
    });

    const cashflowEvents: ForecastCashflowEvent[] = eventRows.map((row) => {
      const event = mapCashflowEvent(row);
      return {
        id: event.id,
        name: event.name,
        direction: event.direction,
        amount: event.amount,
        expectedDate: event.expectedDate,
        recurrence: event.recurrence,
        recurrenceEndDate: event.recurrenceEndDate ?? null,
        requirement: event.requirement,
        certainty: event.certainty,
        status: event.status,
        visibilityLevel: event.visibilityLevel,
        ownerMemberId: event.ownerMemberId ?? null,
        financialGoalId: event.financialGoalId ?? null,
        debtId: event.debtId ?? null,
      };
    });

    const protectedReserves: ForecastProtectedReserve[] = reserveRows.map(
      (row) => ({
        id: row.id,
        name: row.name,
        amount: numberFromDb(row.amount),
        status: row.status as ForecastProtectedReserve['status'],
      }),
    );

    return { assets, cashflowEvents, protectedReserves };
  }

  /** Latest market price / FX row per key, for valuing market-priced assets. */
  private async loadPricing() {
    const [fxRates] = await Promise.all([
      this.prisma.fxRate.findMany({
        orderBy: [
          { baseCurrency: 'asc' },
          { quoteCurrency: 'asc' },
          { rateTime: 'desc' },
        ],
        distinct: ['baseCurrency', 'quoteCurrency'],
      }),
    ]);

    return {
      // `market_prices` was dropped; prices now cache on the position row and
      // `computeCurrentValue` reads them from there.
      marketPrices: [],
      fxRates: fxRates.map((rate) => ({
        baseCurrency: rate.baseCurrency,
        quoteCurrency: rate.quoteCurrency,
        rate: numberFromDb(rate.rate),
        asOf: rate.rateTime.toISOString(),
        source: rate.source,
      })),
    };
  }
}
