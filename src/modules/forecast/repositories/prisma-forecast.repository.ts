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
import { computeCurrentValue } from '../../../common/utils/money-space.utils';
import { Household } from '../../households/entities/household.entity';
import type {
  ForecastCashflowEvent,
  ForecastLiquidSource,
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
    const [assetRows, eventRows, pricing] = await Promise.all([
      this.prisma.asset.findMany({
        // No sharing filter: every asset the household owns is part of its
        // picture. `status: 'active'` is about whether the money still exists,
        // not about who may see it.
        where: { householdId, deletedAt: null, status: 'active' },
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
          expectedDate: {
            gte: this.toDate(addDaysIso(today, -LOOKBACK_DAYS)) ?? undefined,
            lte: this.toDate(addDaysIso(today, LOOKAHEAD_DAYS)) ?? undefined,
          },
        },
        orderBy: { expectedDate: 'asc' },
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
        type: asset.type,
        valueUpdatedAt: row.valueUpdatedAt?.toISOString().slice(0, 10) ?? null,
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
        ownerMemberId: event.ownerMemberId ?? null,
        financialGoalId: event.financialGoalId ?? null,
        debtId: event.debtId ?? null,
        settlementAssetId: event.settlementAssetId ?? null,
      };
    });

    return { assets, cashflowEvents };
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
