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
  deriveSnapshotStatus,
} from '../../../common/utils/money-space.utils';
import { AS_OF } from '../../../common/seed/money-space.seed';
import { Household } from '../../households/entities/household.entity';
import { SnapshotDetail } from '../entities/snapshot-detail.entity';
import { MarketDataService } from '../../market-data/market-data.service';
import {
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

  async getUpcomingDueTotal(householdId: string): Promise<number> {
    const agg = await this.prisma.upcomingPayment.aggregate({
      where: { householdId, deletedAt: null, status: 'unpaid' },
      _sum: { amount: true },
    });
    return Number(agg._sum.amount ?? 0);
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

  private async valuationLineage(assetId: string) {
    const v = await this.prisma.assetValueHistory.findFirst({
      where: { assetId, deletedAt: null },
      orderBy: { valuationDate: 'desc' },
    });
    if (!v) return {};
    return {
      valuationId: v.id,
      valuationMethod: (v as any).valuationMethod as string | undefined,
      valuationDate: v.valuationDate
        ? new Date(v.valuationDate).toISOString().slice(0, 10)
        : undefined,
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
    const rows = await this.prisma.assetValueHistory.findMany({
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

  private async toLine(asset: any): Promise<SnapshotAssetLine> {
    // Only market-priced assets need market prices / fx rates. Manual (cash,
    // bank) and formula-calculated (savings) assets value from their own row,
    // so skip the two pricing queries for them. Run pricing (when needed) and
    // the valuation-lineage lookup concurrently instead of sequentially.
    const needsPricing = asset.valuationMode === 'market_priced';
    const [pricing, lineage] = await Promise.all([
      needsPricing
        ? this.loadPricing()
        : Promise.resolve({ marketPrices: [], fxRates: [] }),
      this.valuationLineage(asset.id),
    ]);
    const value = computeCurrentValue(
      asset,
      pricing.marketPrices,
      pricing.fxRates,
      AS_OF,
    );
    return {
      assetId: asset.id,
      assetName: asset.name,
      assetType: asset.type,
      liquidity: asset.liquidity,
      value,
      currency: asset.currency,
      visibilityLevel: 'detail',
      ...lineage,
    };
  }

  async getActiveAssetLines(householdId: string): Promise<SnapshotAssetLine[]> {
    // assets + pricing + per-asset valuation lineage all resolve concurrently
    // as three queries. `lineageByAsset` batches what was previously one
    // `findFirst` per asset (a 1+N inside this transaction).
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
      const value = computeCurrentValue(asset, marketPrices, fxRates, AS_OF);
      const lineage = lineageByAsset.get(asset.id) ?? {};
      lines.push({
        assetId: asset.id,
        assetName: asset.name,
        assetType: asset.type,
        liquidity: asset.liquidity,
        value,
        currency: asset.currency,
        visibilityLevel: 'detail',
        ...lineage,
      });
    }
    return lines;
  }

  async getActiveAssetLine(
    householdId: string,
    assetId: string,
  ): Promise<SnapshotAssetLine | undefined> {
    const row = await this.prisma.asset.findFirst({
      where: { id: assetId, householdId, deletedAt: null, status: 'active' },
      include: {
        marketPositions: { where: { deletedAt: null }, take: 1 },
        calculationTerms: { where: { deletedAt: null }, take: 1 },
      },
    });
    if (!row) return undefined;
    const asset = mapAsset(
      row,
      row.marketPositions[0],
      row.calculationTerms[0],
    );
    return this.toLine(asset);
  }

  // --- Snapshot upsert (per-day, granular) -----------------------------------

  async ensureTodaySnapshot(
    householdId: string,
    today: string,
  ): Promise<string> {
    // Fast path (the common case after the first write of the day): today's
    // snapshot already exists, so a single non-transactional SELECT resolves it
    // — no open+commit round-trip on the session pooler.
    const already = await this.prisma.snapshot.findFirst({
      where: {
        householdId,
        snapshotDate: this.toDate(today) ?? undefined,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (already) return already.id;

    // First change today → create the parent + seed a FULL child set, atomically.
    return this.runInTransaction(async (tx) => {
      const existing = await tx.snapshot.findFirst({
        where: {
          householdId,
          snapshotDate: this.toDate(today) ?? undefined,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (existing) return existing.id;

      // First change today → create the parent + seed a FULL child set.
      const lines = await this.getActiveAssetLines(householdId);
      const snapshotId = uuidv7();
      const inserted = await tx.$executeRaw`
        INSERT INTO snapshots
          (id, household_id, snapshot_date, total_liquid, total_savings,
           total_long_term_assets, total_debt, upcoming_due_amount,
           attention_count, created_by, created_at)
        SELECT
          ${snapshotId}::uuid, h.id, ${this.toDate(today)}::date,
          0, 0, 0, 0, 0, 0, h.created_by, now()
        FROM households h
        WHERE h.id = ${householdId}::uuid AND h.deleted_at IS NULL
        ON CONFLICT (household_id, snapshot_date) WHERE deleted_at IS NULL
        DO NOTHING
      `;
      if (inserted === 0) {
        // Either the household is missing, or a concurrent request won the
        // insert. Re-select: a row means the race; none means missing household.
        const raced = await tx.snapshot.findFirst({
          where: {
            householdId,
            snapshotDate: this.toDate(today) ?? undefined,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (raced) return raced.id;
        throw new NotFoundException(`Household "${householdId}" was not found`);
      }

      if (lines.length > 0) {
        await tx.snapshotAssetValue.createMany({
          data: lines.map((line) => ({
            id: uuidv7(),
            householdId,
            snapshotId,
            assetId: line.assetId,
            assetName: line.assetName,
            assetType: line.assetType as any,
            liquidity: line.liquidity as any,
            value: line.value,
            currency: line.currency,
            valuationId: line.valuationId ?? null,
            valuationMethod: (line.valuationMethod ?? null) as any,
            valuationDate: line.valuationDate
              ? this.toDate(line.valuationDate)
              : null,
            visibilityLevel: line.visibilityLevel as any,
          })),
        });
      }

      await tx.$executeRaw`
        INSERT INTO audit_logs
          (id, household_id, actor_id, action, entity_type, entity_id, metadata, created_at)
        SELECT ${uuidv7()}::uuid, h.id, NULL, 'snapshot.auto_created',
               'snapshot', ${snapshotId}::uuid, '{}'::jsonb, now()
        FROM households h WHERE h.id = ${householdId}::uuid AND h.deleted_at IS NULL
      `;
      await this.recomputeSnapshotTotals(snapshotId, householdId);
      return snapshotId;
    });
  }

  async upsertAssetLine(
    snapshotId: string,
    householdId: string,
    line: SnapshotAssetLine,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO snapshot_asset_values
        (id, household_id, snapshot_id, asset_id, asset_name, asset_type,
         liquidity, value, currency, valuation_id, valuation_method,
         valuation_date, visibility_level, created_at)
      VALUES (
        ${uuidv7()}::uuid, ${householdId}::uuid, ${snapshotId}::uuid,
        ${line.assetId}::uuid, ${line.assetName}, ${line.assetType}::"AssetType",
        ${line.liquidity}::"AssetLiquidity", ${line.value}::numeric, ${line.currency},
        ${line.valuationId ?? null}::uuid,
        ${(line.valuationMethod ?? null) as any}::"AssetValuationMethod",
        ${line.valuationDate ? this.toDate(line.valuationDate) : null}::date,
        ${line.visibilityLevel}::"VisibilityLevel", now()
      )
      ON CONFLICT (snapshot_id, asset_id) DO UPDATE SET
        asset_name = EXCLUDED.asset_name,
        asset_type = EXCLUDED.asset_type,
        liquidity = EXCLUDED.liquidity,
        value = EXCLUDED.value,
        currency = EXCLUDED.currency,
        valuation_id = EXCLUDED.valuation_id,
        valuation_method = EXCLUDED.valuation_method,
        valuation_date = EXCLUDED.valuation_date,
        visibility_level = EXCLUDED.visibility_level
    `;
  }

  async removeAssetLine(snapshotId: string, assetId: string): Promise<void> {
    await this.prisma.snapshotAssetValue.deleteMany({
      where: { snapshotId, assetId },
    });
  }

  async recomputeSnapshotTotals(
    snapshotId: string,
    householdId: string,
  ): Promise<void> {
    // Single round-trip: compute the child SUM-per-liquidity and the three
    // household-level aggregates (debt / upcoming / attention) inside the
    // UPDATE via correlated subqueries, so recompute is one statement instead
    // of groupBy + 3 aggregates + update (was 3 round-trips).
    await this.prisma.$executeRaw`
      UPDATE snapshots SET
        total_liquid = COALESCE((
          SELECT SUM(value) FROM snapshot_asset_values
          WHERE snapshot_id = ${snapshotId}::uuid AND liquidity = 'usable_now'
        ), 0),
        total_savings = COALESCE((
          SELECT SUM(value) FROM snapshot_asset_values
          WHERE snapshot_id = ${snapshotId}::uuid AND liquidity = 'not_immediately_usable'
        ), 0),
        total_long_term_assets = COALESCE((
          SELECT SUM(value) FROM snapshot_asset_values
          WHERE snapshot_id = ${snapshotId}::uuid AND liquidity = 'long_term'
        ), 0),
        total_debt = COALESCE((
          SELECT SUM(outstanding_amount) FROM debts
          WHERE household_id = ${householdId}::uuid AND deleted_at IS NULL AND status = 'active'
        ), 0),
        upcoming_due_amount = COALESCE((
          SELECT SUM(amount) FROM upcoming_payments
          WHERE household_id = ${householdId}::uuid AND deleted_at IS NULL AND status = 'unpaid'
        ), 0),
        attention_count = COALESCE((
          SELECT COUNT(*) FROM attention_items
          WHERE household_id = ${householdId}::uuid AND status = 'open'
        ), 0)
      WHERE id = ${snapshotId}::uuid
    `;
  }

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
    }));

    const totalAssets =
      Number(row.totalLiquid) +
      Number(row.totalSavings) +
      Number(row.totalLongTermAssets);

    // status/sourceMode are DERIVED, not stored (columns dropped in PR3).
    const status = deriveSnapshotStatus({
      totalAssets,
      totalDebt: Number(row.totalDebt),
      totalLiquid: Number(row.totalLiquid),
      upcomingDueAmount: Number(row.upcomingDueAmount),
      attentionCount: row.attentionCount,
      assetCount: items.length,
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
      status,
      sourceMode,
      note: row.note ?? undefined,
      createdAt: new Date(row.createdAt).toISOString(),
      items,
    };
  }
}
