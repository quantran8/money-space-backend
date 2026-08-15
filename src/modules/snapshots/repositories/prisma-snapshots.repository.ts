import { Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '../../../common/utils/uuid';
import {
  mapAsset,
  mapFxRate,
  mapHousehold,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import {
  computeCurrentValue,
  deriveSnapshotSourceMode,
} from '../../../common/utils/money-space.utils';
import { deriveSnapshotFinancialState } from '../domain/snapshot-financial-state';
import { Household } from '../../households/entities/household.entity';
import { SnapshotDetail } from '../entities/snapshot-detail.entity';
import { MarketDataService } from '../../market-data/market-data.service';
import {
  CreateSnapshotInput,
  SnapshotAssetLine,
  SnapshotsRepository,
} from './snapshots.repository.interface';

@Injectable()
export class PrismaSnapshotsRepository
  extends PrismaRepository
  implements SnapshotsRepository
{
  constructor(
    prisma: PrismaService,
    private readonly marketData: MarketDataService,
  ) {
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

  async getOutstandingDebtTotal(householdId: string): Promise<number> {
    const agg = await this.prisma.debt.aggregate({
      where: { householdId, deletedAt: null, status: 'active' },
      _sum: { outstandingAmount: true },
    });
    return Number(agg._sum.outstandingAmount ?? 0);
  }

  async getOpenAttentionCount(householdId: string): Promise<number> {
    return this.prisma.attentionItem.count({
      where: { householdId, status: 'open' },
    });
  }

  // --- Valuation of active assets (self-contained; no AssetsService dep) -----

  private async loadPricing() {
    const [prices, rates] = await Promise.all([
      this.marketData.getMarketPrices(),
      this.findLatestFxRates(),
    ]);
    return {
      marketPrices: prices,
      fxRates: rates.map((r) => mapFxRate(r)),
    };
  }

  private lineageFromRow(v: any): {
    valuationId?: string;
    valuationMethod?: string;
    valuationDate?: string;
  } {
    if (!v) return {};
    return {
      valuationId: v.id,
      valuationMethod: v.valuationMethod as string | undefined,
      valuationDate: v.valuationDate
        ? new Date(v.valuationDate).toISOString().slice(0, 10)
        : undefined,
    };
  }

  /**
   * Latest non-deleted valuation lineage for every asset in the household, in a
   * SINGLE query. Replaces a per-asset `valuationLineage` lookup that fired one
   * `findFirst` per asset (a 1+N inside `getActiveAssetLines`, which runs in
   * `ensureTodaySnapshot`'s interactive transaction). `distinct: ['assetId']`
   * with `orderBy assetId, valuationDate desc` returns the newest row per asset;
   * it is served by `@@index([householdId, assetId, valuationDate(sort: Desc)])`.
   */
  private async latestLineageByAsset(
    householdId: string,
  ): Promise<Map<string, ReturnType<typeof this.lineageFromRow>>> {
    const rows = await this.prisma.assetValuation.findMany({
      where: { householdId, deletedAt: null },
      orderBy: [{ assetId: 'asc' }, { valuationDate: 'desc' }],
      distinct: ['assetId'],
      select: {
        id: true,
        assetId: true,
        valuationMethod: true,
        valuationDate: true,
      },
    });
    const map = new Map<string, ReturnType<typeof this.lineageFromRow>>();
    for (const row of rows) {
      map.set(row.assetId, this.lineageFromRow(row));
    }
    return map;
  }

  /**
   * Active assets valued as of `asOfDate`, carrying their REAL classification.
   *
   * Replaces `getActiveAssetLines`, which hardcoded `visibilityLevel: 'detail'`
   * for every line. That was harmless while snapshots were an internal
   * bookkeeping artifact, but §17 freezes classification INTO the snapshot — so
   * the old shape would have recorded every private asset as shared, and the
   * frozen record would say something untrue about the household forever.
   *
   * Three queries in parallel; the lineage lookup is batched (it was a 1+N).
   */
  async getClassifiedAssetLines(
    householdId: string,
    asOfDate: string,
  ): Promise<SnapshotAssetLine[]> {
    const [assets, { marketPrices, fxRates }, lineageByAsset] =
      await Promise.all([
        this.prisma.asset.findMany({
          where: { householdId, deletedAt: null, status: 'active' },
          include: {
            marketPositions: { where: { deletedAt: null }, take: 1 },
            calculationTerms: { where: { deletedAt: null }, take: 1 },
          },
        }),
        this.loadPricing(),
        this.latestLineageByAsset(householdId),
      ]);

    const lines: SnapshotAssetLine[] = [];
    for (const row of assets) {
      const asset = mapAsset(
        row,
        row.marketPositions[0],
        row.calculationTerms[0],
      );
      const raw = row as unknown as {
        financialNature?: string;
        visibilityLevel?: string;
        holderMemberId?: string | null;
        privacyOwnerMemberId?: string | null;
      };
      lines.push({
        assetId: asset.id,
        assetName: asset.name,
        assetType: asset.type,
        liquidity: asset.liquidity,
        // Valued at the caller's `asOfDate`, not a hardcoded seed constant: a
        // formula-calculated saving deposit accrues, so the date decides the
        // number that gets frozen.
        value: computeCurrentValue(asset, marketPrices, fxRates, asOfDate),
        currency: asset.currency,
        visibilityLevel: raw.visibilityLevel ?? 'detail',
        financialNature: raw.financialNature ?? 'household',
        holderMemberId: raw.holderMemberId ?? null,
        privacyOwnerMemberId: raw.privacyOwnerMemberId ?? null,
        ...(lineageByAsset.get(asset.id) ?? {}),
      });
    }
    return lines;
  }

  async getLastSnapshotCreatedAt(householdId: string): Promise<Date | null> {
    const row = await this.prisma.snapshot.findFirst({
      where: { householdId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }

  /**
   * The §26 write: three statements, one transaction.
   *
   * Everything expensive — valuing assets, running the forecast, totalling debt
   * — already happened OUTSIDE this. An interactive transaction is one
   * connection held open on the direct client; doing the reads inside it is how
   * the old auto-snapshot path used to hit "Transaction not found".
   */
  async createSnapshot(input: CreateSnapshotInput): Promise<void> {
    await this.runInTransaction(async (tx) => {
      await tx.snapshot.create({
        data: {
          id: input.id,
          householdId: input.householdId,
          snapshotDate: new Date(`${input.snapshotDate}T00:00:00.000Z`),
          totalLiquid: input.totalLiquid,
          totalSavings: input.totalSavings,
          totalLongTermAssets: input.totalLongTermAssets,
          totalDebt: input.totalDebt,
          upcomingDueAmount: input.upcomingDueAmount,
          attentionCount: input.attentionCount,
          protectedReserveAmount: input.protectedReserveAmount,
          forecastHorizonDays: input.forecastHorizonDays,
          upcomingIncomeAmount: input.upcomingIncomeAmount,
          upcomingOutgoingAmount: input.upcomingOutgoingAmount,
          // Pass NULL through as NULL, and negatives through unchanged: a
          // projected shortfall is the single most important thing a snapshot
          // can record (§10 forbids a `>= 0` CHECK on these two).
          lowestProjectedBalance: input.lowestProjectedBalance,
          flexibleMoney: input.flexibleMoney,
          note: input.note ?? null,
          createdById: input.createdById ?? null,
        } as never,
      });

      // One bulk insert, not N — a household with 30 assets would otherwise
      // hold the transaction open for 30 round-trips.
      if (input.lines.length > 0) {
        await tx.snapshotAssetValue.createMany({
          data: input.lines.map((line) => ({
            id: uuidv7(),
            householdId: input.householdId,
            snapshotId: input.id,
            assetId: line.assetId,
            assetName: line.assetName,
            assetType: line.assetType,
            liquidity: line.liquidity,
            financialNature: line.financialNature,
            holderMemberId: this.asUuid(line.holderMemberId ?? null),
            privacyOwnerMemberId: this.asUuid(
              line.privacyOwnerMemberId ?? null,
            ),
            value: line.value,
            currency: line.currency,
            valuationId: this.asUuid(line.valuationId ?? null),
            valuationMethod: line.valuationMethod ?? null,
            valuationDate: this.toDate(line.valuationDate ?? null),
            visibilityLevel: line.visibilityLevel,
          })) as never,
        });
      }

      await tx.auditLog.create({
        data: {
          id: uuidv7(),
          householdId: input.householdId,
          actorId: this.asUuid(input.createdById ?? null),
          action: 'snapshot.created',
          entityType: 'snapshot',
          entityId: input.id,
          metadata: {
            snapshotDate: input.snapshotDate,
            assetLineCount: input.lines.length,
            forecastHorizonDays: input.forecastHorizonDays,
          },
        } as never,
      });
    });
  }

  // --- Snapshot upsert (per-day, granular) -----------------------------------

  // Snapshots grow one row per day, so cap the list at the most recent window
  // (index-backed on householdId, snapshotDate DESC) rather than returning the
  // household's entire history — which grows without bound as it ages.
  private static readonly LIST_SNAPSHOTS_LIMIT = 365;

  async listSnapshots(householdId: string): Promise<SnapshotDetail[]> {
    const rows = await this.prisma.snapshot.findMany({
      where: { householdId, deletedAt: null },
      orderBy: { snapshotDate: 'desc' },
      include: { snapshotAssetValues: true },
      take: PrismaSnapshotsRepository.LIST_SNAPSHOTS_LIMIT,
    });
    return rows.map((row) => this.toDetail(row));
  }

  async getSnapshotById(
    householdId: string,
    snapshotId: string,
  ): Promise<SnapshotDetail | undefined> {
    const row = await this.prisma.snapshot.findFirst({
      where: { id: snapshotId, householdId, deletedAt: null },
      include: { snapshotAssetValues: true },
    });
    return row ? this.toDetail(row) : undefined;
  }

  private toDetail(row: any): SnapshotDetail {
    const items = (row.snapshotAssetValues ?? []).map((v: any) => ({
      id: v.id,
      assetId: v.assetId,
      assetName: v.assetName,
      assetType: v.assetType,
      liquidity: v.liquidity,
      value: Number(v.value),
      currency: v.currency,
      valuationId: v.valuationId ?? undefined,
      valuationMethod: v.valuationMethod ?? undefined,
      valuationDate: v.valuationDate
        ? new Date(v.valuationDate).toISOString().slice(0, 10)
        : undefined,
      visibilityLevel: v.visibilityLevel,
      // Frozen classification (§17): read from the LINE, never re-read through
      // the asset — the asset may have been reclassified since.
      financialNature: v.financialNature ?? 'household',
      holderMemberId: v.holderMemberId ?? null,
      privacyOwnerMemberId: v.privacyOwnerMemberId ?? null,
    }));

    // Pre-v3.1 snapshots have no foresight context. NULL is carried through as
    // NULL rather than coerced to 0 — "we didn't record this" and "it was
    // zero" are different facts, and only one of them is honest.
    const lowestProjectedBalance =
      row.lowestProjectedBalance === null ||
      row.lowestProjectedBalance === undefined
        ? null
        : Number(row.lowestProjectedBalance);
    const flexibleMoney =
      row.flexibleMoney === null || row.flexibleMoney === undefined
        ? null
        : Number(row.flexibleMoney);
    const protectedReserveAmount = Number(row.protectedReserveAmount ?? 0);

    const { state, reasons } = deriveSnapshotFinancialState({
      lowestProjectedBalance,
      flexibleMoney,
      protectedReserveAmount,
      assetLineCount: items.length,
    });
    const sourceMode = deriveSnapshotSourceMode(
      items.map((i: { valuationMethod?: string }) => i.valuationMethod),
    );

    return {
      id: row.id,
      householdId: row.householdId,
      snapshotDate: new Date(row.snapshotDate).toISOString().slice(0, 10),
      totalLiquid: Number(row.totalLiquid),
      totalSavings: Number(row.totalSavings),
      totalLongTermAssets: Number(row.totalLongTermAssets),
      totalDebt: Number(row.totalDebt),
      upcomingDueAmount: Number(row.upcomingDueAmount),
      attentionCount: row.attentionCount,
      protectedReserveAmount,
      forecastHorizonDays: Number(row.forecastHorizonDays ?? 30),
      upcomingIncomeAmount: Number(row.upcomingIncomeAmount ?? 0),
      upcomingOutgoingAmount: Number(row.upcomingOutgoingAmount ?? 0),
      lowestProjectedBalance,
      flexibleMoney,
      financialState: state,
      financialStateReasons: reasons,
      sourceMode,
      note: row.note ?? undefined,
      createdAt: new Date(row.createdAt).toISOString(),
      items,
    };
  }
}
