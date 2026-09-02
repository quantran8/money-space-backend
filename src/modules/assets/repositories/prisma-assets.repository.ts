import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidv7 } from '../../../common/utils/uuid';
import {
  mapAsset,
  mapAssetValueHistory,
  mapFxRate,
  mapHousehold,
  mapMoneyEvent,
  mapSnapshot,
} from '../../../common/repositories/money-space.mapper';
import {
  DbRow,
  PrismaRepository,
} from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { Asset, AssetClass } from '../entities/asset.entity';
import { AssetValueHistory } from '../entities/asset-value-history.entity';
import { SnapshotPoint } from '../../dashboard/entities/snapshot-point.entity';
import { Household } from '../../households/entities/household.entity';
import { FxRate } from '../../market-data/entities/fx-rate.entity';
import { MoneyEvent } from '../../money-events/entities/money-event.entity';
import { AssetsRepository } from './assets.repository.interface';

@Injectable()
export class PrismaAssetsRepository
  extends PrismaRepository
  implements AssetsRepository
{
  constructor(prisma: PrismaService) {
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

  async findAssetById(
    householdId: string,
    assetId: string,
  ): Promise<Asset | undefined> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, householdId, deletedAt: null },
      include: {
        marketPositions: { where: { deletedAt: null }, take: 1 },
        calculationTerms: { where: { deletedAt: null }, take: 1 },
      },
    });

    return asset
      ? mapAsset(asset, asset.marketPositions[0], asset.calculationTerms[0])
      : undefined;
  }

  async findActiveMarketAssetBySymbol(
    householdId: string,
    assetClass: AssetClass,
    symbol: string,
  ): Promise<Asset | undefined> {
    const asset = await this.prisma.asset.findFirst({
      where: {
        householdId,
        status: 'active',
        deletedAt: null,
        marketPositions: {
          some: {
            assetClass,
            symbol: { equals: symbol, mode: 'insensitive' },
            deletedAt: null,
          },
        },
      },
      include: {
        marketPositions: {
          where: {
            assetClass,
            symbol: { equals: symbol, mode: 'insensitive' },
            deletedAt: null,
          },
          take: 1,
        },
        calculationTerms: { where: { deletedAt: null }, take: 1 },
      },
    });

    return asset
      ? mapAsset(asset, asset.marketPositions[0], asset.calculationTerms[0])
      : undefined;
  }

  async insertAsset(asset: Asset): Promise<void> {
    // Single round-trip: insert the asset while deriving `created_by` from the
    // household row in one statement. If the household doesn't exist (or is
    // soft-deleted) the SELECT yields no row, nothing is inserted, and we
    // surface a 404 — matching the previous assertHousehold behaviour.
    //
    // `updated_at` is NOT NULL with no DB default — Prisma's @updatedAt fills it
    // on ORM writes, but a raw INSERT must set it explicitly (now()).
    const currentValue = asset.manualValue ?? 0;
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO assets
        (id, household_id, name, type, valuation_mode, current_value, area_sqm,
         currency, value_updated_at, liquidity, counts_as_flexible, note,
         created_by, updated_at, holder_member_id)
      SELECT
        ${asset.id}::uuid,
        h.id,
        ${asset.name},
        ${asset.type}::"AssetType",
        ${asset.valuationMode}::"AssetValuationMode",
        ${currentValue}::numeric,
        ${asset.areaSqm ?? null}::numeric,
        ${asset.currency},
        now(),
        ${asset.liquidity}::"AssetLiquidity",
        ${asset.countsAsFlexible ?? null}::boolean,
        ${asset.note},
        h.created_by,
        now(),
        ${this.asUuid(asset.holderMemberId ?? null)}::uuid
      FROM households h
      WHERE h.id = ${asset.householdId}::uuid
        AND h.deleted_at IS NULL
    `;

    if (inserted === 0) {
      throw new NotFoundException(
        `Household "${asset.householdId}" was not found`,
      );
    }

    await this.upsertAssetDetails(asset);
  }

  async insertRevaluationEvent(event: {
    id: string;
    householdId: string;
    assetId: string;
    amount: number;
    isoDate: string;
    note?: string;
  }): Promise<void> {
    // A revaluation is a neutral `asset_update` money event linked to the asset
    // it re-prices (via `to_asset_id`, so `findMoneyEventsByAsset` surfaces it).
    // It moves no wallet and is excluded from income/expense reports. `amount`
    // carries the signed value delta (new − old). Derives `created_by` from the
    // household in one round-trip, like `insertAsset`/`insertMoneyEvent`.
    await this.prisma.$executeRaw`
      INSERT INTO money_events
        (id, household_id, description, event_type, category, amount,
         fee_amount, currency, event_date, direction, to_asset_id,
         created_by, updated_at)
      SELECT
        ${event.id}::uuid,
        h.id,
        ${event.note ?? ''},
        'asset_update'::"MoneyEventType",
        'other',
        ${event.amount}::numeric,
        0::numeric,
        'VND',
        ${this.toDate(event.isoDate)}::date,
        'neutral'::"MoneyDirection",
        ${event.assetId}::uuid,
        h.created_by,
        now()
      FROM households h
      WHERE h.id = ${event.householdId}::uuid
        AND h.deleted_at IS NULL
    `;
  }

  async insertQuantityAdjustmentEvent(event: {
    id: string;
    householdId: string;
    assetId: string;
    amount: number;
    quantityBefore: number;
    quantityAfter: number;
    isoDate: string;
    note?: string;
  }): Promise<void> {
    // Same shape and same neutrality as `insertRevaluationEvent`, different
    // meaning: the quantity moved, not the price. `amount` records what the
    // correction was worth for the ledger row to be readable; nothing derives a
    // balance from it (`sumEventContributionsAfter` skips this type outright),
    // so the position stays the single source of the asset's value.
    await this.prisma.$executeRaw`
      INSERT INTO money_events
        (id, household_id, description, event_type, category, amount,
         fee_amount, currency, event_date, direction, to_asset_id,
         quantity_before, quantity_after, created_by, updated_at)
      SELECT
        ${event.id}::uuid,
        h.id,
        ${event.note ?? ''},
        'asset_quantity_adjustment'::"MoneyEventType",
        'other',
        ${event.amount}::numeric,
        0::numeric,
        'VND',
        ${this.toDate(event.isoDate)}::date,
        'neutral'::"MoneyDirection",
        ${event.assetId}::uuid,
        ${event.quantityBefore}::numeric,
        ${event.quantityAfter}::numeric,
        h.created_by,
        now()
      FROM households h
      WHERE h.id = ${event.householdId}::uuid
        AND h.deleted_at IS NULL
    `;
  }

  async insertAssetPurchaseEvent(event: {
    id: string;
    householdId: string;
    assetId: string;
    amount: number;
    isoDate: string;
    note: string;
    fundingAssetId?: string | null;
  }): Promise<void> {
    // Two different acts share this row, told apart by whether a funding wallet
    // was named:
    //
    // - With a wallet — a real purchase. `outflow` from that wallet into the
    //   asset (`to_asset_id`). The caller debits the wallet, so net worth is
    //   unchanged: money left one place and arrived in another.
    // - Without — the household is declaring something it already owns. Nothing
    //   moved, so the row stays `neutral` with no source, and no balance is
    //   manufactured or debited.
    const fundingAssetId = event.fundingAssetId ?? null;
    await this.prisma.$executeRaw`
      INSERT INTO money_events
        (id, household_id, description, event_type, category, amount,
         fee_amount, currency, event_date, direction, from_asset_id, to_asset_id,
         created_by, updated_at)
      SELECT
        ${event.id}::uuid,
        h.id,
        ${event.note},
        'asset_purchase'::"MoneyEventType",
        'investment',
        ${event.amount}::numeric,
        0::numeric,
        'VND',
        ${this.toDate(event.isoDate)}::date,
        ${fundingAssetId ? 'outflow' : 'neutral'}::"MoneyDirection",
        ${fundingAssetId}::uuid,
        ${event.assetId}::uuid,
        h.created_by,
        now()
      FROM households h
      WHERE h.id = ${event.householdId}::uuid
        AND h.deleted_at IS NULL
    `;
  }

  async updateAsset(assetId: string, asset: Asset): Promise<void> {
    await this.prisma.asset.updateMany({
      where: { id: assetId, householdId: asset.householdId, deletedAt: null },
      data: {
        name: asset.name,
        type: asset.type,
        valuationMode: asset.valuationMode,
        currentValue: asset.manualValue ?? 0,
        currency: asset.currency,
        valueUpdatedAt: new Date(),
        liquidity: asset.liquidity,
        countsAsFlexible: asset.countsAsFlexible ?? null,
        note: asset.note,
        status: asset.status,
        soldAt: asset.soldAt ? new Date(asset.soldAt) : null,
        areaSqm: asset.areaSqm ?? null,
        holderMemberId: asset.holderMemberId ?? null,
      } as any,
    });
    await this.upsertAssetDetails(asset);
  }

  /**
   * Write back the derived current value so `assets.current_value` is a true
   * cache (dashboards / view_summary can read it without recomputing). Called
   * by `upsertCurrentValuation` after it computes the value for ANY mode — the
   * plain create/update path only knew `manualValue`, so the column went stale
   * for market_priced / formula assets.
   */
  async updateAssetCurrentValue(assetId: string, value: number): Promise<void> {
    await this.prisma.asset.updateMany({
      where: { id: assetId, deletedAt: null },
      data: { currentValue: value, valueUpdatedAt: new Date() } as any,
    });
  }

  /**
   * Confirm the recorded value is still correct (spec 04 §12).
   *
   * Bumps `value_updated_at` WITHOUT touching `current_value` — that is the
   * whole point. "I checked, it hasn't changed" is real information about
   * freshness, and forcing the user to re-type the same number to express it
   * would be busywork that also risks a typo.
   *
   * Scoped by household as well as id so a stray id from another household
   * can't silently succeed.
   */
  async confirmAssetsUnchanged(
    householdId: string,
    assetIds: string[],
  ): Promise<number> {
    const result = await this.prisma.asset.updateMany({
      where: {
        householdId,
        deletedAt: null,
        status: 'active',
        ...(assetIds.length > 0 ? { id: { in: assetIds } } : {}),
      },
      data: { valueUpdatedAt: new Date() } as any,
    });
    return result.count;
  }

  async deleteAsset(assetId: string): Promise<void> {
    await this.prisma.asset.updateMany({
      where: { id: assetId },
      data: { deletedAt: new Date() },
    });
  }

  async deleteAssetDetails(assetId: string): Promise<void> {
    const deletedAt = new Date();
    // Sequential: runs inside the asset delete transaction's single connection.
    await this.prisma.assetMarketPosition.updateMany({
      where: { assetId, deletedAt: null },
      data: { deletedAt },
    });
    await this.prisma.assetCalculationTerm.updateMany({
      where: { assetId, deletedAt: null },
      data: { deletedAt },
    });
  }

  async findAssetValueHistoryByAsset(
    householdId: string,
    assetId: string,
  ): Promise<AssetValueHistory[]> {
    const valuations = await this.prisma.assetValuation.findMany({
      where: { householdId, assetId, deletedAt: null },
      orderBy: { valuationDate: 'desc' },
    });

    return valuations.map((valuation) => mapAssetValueHistory(valuation));
  }

  async findAssetValueHistory(
    assetId: string,
    valuationDate: string,
  ): Promise<AssetValueHistory | undefined> {
    // The by-date lookup targets ONLY the unlinked "value now" / dated cache row
    // (`money_event_id IS NULL`). Without this filter, `findFirst` could return
    // an event-linked point that happens to share the date (e.g. today's wallet
    // credit), and the caller would then overwrite that event's point — nulling
    // its `money_event_id` and clobbering its value. Matches the partial-unique
    // index `asset_value_history_asset_date_cache_unique`.
    const valuation = await this.prisma.assetValuation.findFirst({
      where: {
        assetId,
        valuationDate: this.toDate(valuationDate) ?? undefined,
        moneyEventId: null,
        deletedAt: null,
      },
    });

    return valuation ? mapAssetValueHistory(valuation) : undefined;
  }

  /**
   * Bulk upsert of the daily market valuation points.
   *
   * The per-asset path does a lookup then a create/update — three round-trips
   * per asset, which for a household with many positions blows past the
   * interactive-transaction timeout and, run across every household by the
   * daily job, would exhaust the small connection pool. This writes the whole
   * batch in ONE statement.
   *
   * Conflict target is the partial unique index
   * `asset_valuations_asset_date_cache_unique (asset_id, valuation_date)
   *  WHERE money_event_id IS NULL AND deleted_at IS NULL` — i.e. exactly the
   * unlinked "value on this date" row. Event-linked points are untouched, so a
   * money event's own point is never clobbered by a re-price.
   */
  async upsertMarketValuationPoints(
    valuations: AssetValueHistory[],
  ): Promise<void> {
    if (valuations.length === 0) return;

    const rows = valuations.map(
      (v) => Prisma.sql`(
        ${v.id}::uuid,
        ${v.householdId}::uuid,
        ${v.assetId}::uuid,
        ${v.value}::numeric,
        ${v.currency},
        ${v.valuationDate}::date,
        ${v.method}::"AssetValuationMethod",
        ${v.source ?? null},
        ${v.confidenceLevel ?? null}::"ConfidenceLevel",
        ${v.note ?? null}
      )`,
    );

    await this.prisma.$executeRaw`
      INSERT INTO "asset_valuations" (
        "id", "household_id", "asset_id", "value", "currency",
        "valuation_date", "valuation_method", "source", "confidence_level",
        "note", "created_at", "updated_at"
      )
      SELECT v.id, v.household_id, v.asset_id, v.value, v.currency,
             v.valuation_date, v.valuation_method, v.source, v.confidence_level,
             v.note, NOW(), NOW()
      FROM (VALUES ${Prisma.join(rows)}) AS v (
        id, household_id, asset_id, value, currency, valuation_date,
        valuation_method, source, confidence_level, note
      )
      ON CONFLICT ("asset_id", "valuation_date")
        WHERE "money_event_id" IS NULL AND "deleted_at" IS NULL
      DO UPDATE SET
        "value" = EXCLUDED."value",
        "currency" = EXCLUDED."currency",
        "valuation_method" = EXCLUDED."valuation_method",
        "source" = EXCLUDED."source",
        "confidence_level" = EXCLUDED."confidence_level",
        "note" = EXCLUDED."note",
        "updated_at" = NOW()
    `;
  }

  /**
   * Bulk `current_value` write. One UPDATE ... FROM (VALUES ...) instead of one
   * statement per asset, for the same reason as above.
   *
   * Bumps `value_updated_at` like the single-asset path does: the daily job IS
   * a re-valuation, so freshness (`getDataFreshness`, attention rules, the
   * forecast's staleness cut-off) must see it. Leaving it out made every
   * market_priced asset look days old while its price was current.
   */
  async updateAssetCurrentValues(
    values: Array<{ assetId: string; value: number }>,
  ): Promise<void> {
    if (values.length === 0) return;

    const rows = values.map(
      (v) => Prisma.sql`(${v.assetId}::uuid, ${v.value}::numeric)`,
    );

    await this.prisma.$executeRaw`
      UPDATE "assets" AS a
      SET "current_value" = v.value,
          "value_updated_at" = NOW(),
          "updated_at" = NOW()
      FROM (VALUES ${Prisma.join(rows)}) AS v (asset_id, value)
      WHERE a."id" = v.asset_id
    `;
  }

  async insertAssetValueHistory(valuation: AssetValueHistory): Promise<void> {
    // A valuation record is identified by the money event that produced it (one
    // record per asset that event touched). When a `moneyEventId` is set we
    // upsert on `(moneyEventId, assetId)` — so two same-day revaluations of one
    // asset each keep their own point, and editing an event updates exactly its
    // record. Without an event id (legacy / AS_OF cache row) fall back to the
    // one-row-per-`(assetId, valuationDate)` behaviour.
    const existing = valuation.moneyEventId
      ? await this.findAssetValueHistoryByMoneyEvent(
          valuation.moneyEventId,
          valuation.assetId,
        )
      : await this.findAssetValueHistory(
          valuation.assetId,
          valuation.valuationDate,
        );
    const data = {
      householdId: valuation.householdId,
      assetId: valuation.assetId,
      value: valuation.value,
      currency: valuation.currency,
      valuationDate: this.toDate(valuation.valuationDate),
      valuationMethod: valuation.method,
      note: valuation.note,
      moneyEventId: valuation.moneyEventId ?? null,
      // Lineage — provenance of the number (nullable until a source exists).
      source: valuation.source ?? null,
      confidenceLevel: valuation.confidenceLevel ?? null,
      fxRateId: valuation.fxRateId ?? null,
      calculationTermId: valuation.calculationTermId ?? null,
      deletedAt: null,
    } as any;

    if (existing) {
      await this.prisma.assetValuation.update({
        where: { id: existing.id },
        data,
      });
      return;
    }

    await this.prisma.assetValuation.create({
      data: { id: valuation.id, ...data },
    });
  }

  async findHouseholdsNeedingMarketValuation(
    valuationDate: string,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ household_id: string }>>`
      SELECT DISTINCT a."household_id"
      FROM "assets" a
      WHERE a."deleted_at" IS NULL
        AND a."status" = 'active'
        AND a."valuation_mode" = 'market_priced'
        AND NOT EXISTS (
          SELECT 1 FROM "asset_valuations" v
          WHERE v."household_id" = a."household_id"
            AND v."valuation_date" = ${valuationDate}::date
            AND v."valuation_method" = 'market_price_api'
            AND v."deleted_at" IS NULL
        )
      LIMIT ${limit}
    `;
    return rows.map((row) => row.household_id);
  }

  async hasMarketValuationOnDate(
    householdId: string,
    valuationDate: string,
  ): Promise<boolean> {
    const date = this.toDate(valuationDate) ?? undefined;
    const count = await this.prisma.assetValuation.count({
      where: {
        householdId,
        valuationDate: date,
        valuationMethod: 'market_price_api',
        deletedAt: null,
      },
    });
    return count > 0;
  }

  async findAssetValueHistoryByMoneyEvent(
    moneyEventId: string,
    assetId: string,
  ): Promise<AssetValueHistory | undefined> {
    const valuation = await this.prisma.assetValuation.findFirst({
      where: { moneyEventId, assetId, deletedAt: null },
    });

    return valuation ? mapAssetValueHistory(valuation) : undefined;
  }

  async deleteAssetValueHistoryByMoneyEvent(
    moneyEventId: string,
  ): Promise<void> {
    await this.prisma.assetValuation.updateMany({
      where: { moneyEventId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  async deleteAssetValueHistory(assetId: string): Promise<void> {
    await this.prisma.assetValuation.updateMany({
      where: { assetId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  async findMoneyEventsByAsset(
    householdId: string,
    assetId: string,
  ): Promise<MoneyEvent[]> {
    const events = await this.prisma.moneyEvent.findMany({
      where: {
        householdId,
        deletedAt: null,
        OR: [{ fromAssetId: assetId }, { toAssetId: assetId }],
      },
      orderBy: { eventDate: 'asc' },
    });

    return events.map((event) => mapMoneyEvent(event));
  }

  async getSnapshotsByHousehold(householdId: string): Promise<SnapshotPoint[]> {
    const snapshots = await this.prisma.snapshot.findMany({
      where: { householdId, deletedAt: null },
      orderBy: { snapshotDate: 'asc' },
    });

    return snapshots.map((snapshot) => mapSnapshot(snapshot));
  }

  async getFxRates(): Promise<FxRate[]> {
    const rates = await this.findLatestFxRates();
    return rates.map((rate) => mapFxRate(rate));
  }

  private async upsertAssetDetails(asset: Asset): Promise<void> {
    // The market-position and calculation-term upserts touch different tables,
    // but this runs inside the asset create/update transaction whose statements
    // share one connection — so run them sequentially rather than concurrently
    // on the same transaction client.
    await this.upsertAssetMarketPosition(asset);
    await this.upsertAssetCalculationTerm(asset);
  }

  private async upsertAssetMarketPosition(asset: Asset): Promise<void> {
    if (asset.marketPosition) {
      const row = {
        householdId: asset.householdId,
        assetId: asset.id,
        assetClass: asset.marketPosition.assetClass,
        symbol: asset.marketPosition.symbol,
        market: asset.marketPosition.market ?? null,
        quantity: asset.marketPosition.quantity,
        unit: asset.marketPosition.unit,
        quoteCurrency: asset.marketPosition.quoteCurrency,
        purchasePrice: asset.marketPosition.purchasePrice ?? null,
        lastPrice: asset.marketPosition.lastPrice ?? null,
        lastPriceAt: asset.marketPosition.lastPriceAt
          ? new Date(asset.marketPosition.lastPriceAt)
          : null,
        deletedAt: null,
      } as any;
      const existing = await this.findActiveAssetDetail(
        'assetMarketPosition',
        asset.id,
      );

      if (existing) {
        await this.prisma.assetMarketPosition.update({
          where: { id: existing.id },
          data: row,
        });
      } else {
        await this.prisma.assetMarketPosition.create({ data: row });
      }
    } else {
      await this.prisma.assetMarketPosition.updateMany({
        where: { assetId: asset.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }
  }

  private async upsertAssetCalculationTerm(asset: Asset): Promise<void> {
    if (asset.calculationTerm) {
      const row = {
        householdId: asset.householdId,
        assetId: asset.id,
        calculationType: asset.calculationTerm.calculationType,
        principalAmount: asset.calculationTerm.principalAmount,
        currency: asset.currency,
        startDate: this.toDate(asset.calculationTerm.startDate),
        maturityDate: this.toDate(asset.calculationTerm.maturityDate),
        interestRate: asset.calculationTerm.interestRate,
        // Interest payout schedule persists in `payoutFrequency`.
        payoutFrequency:
          asset.calculationTerm.interestPayment === 'monthly'
            ? 'monthly'
            : 'at_maturity',
        nonTermRate: asset.calculationTerm.nonTermRate,
        interestDestination: asset.calculationTerm.interestDestination,
        receivingWalletId: asset.calculationTerm.receivingWalletId,
        deletedAt: null,
      } as any;
      const existing = await this.findActiveAssetDetail(
        'assetCalculationTerm',
        asset.id,
      );

      if (existing) {
        await this.prisma.assetCalculationTerm.update({
          where: { id: existing.id },
          data: row,
        });
      } else {
        await this.prisma.assetCalculationTerm.create({ data: row });
      }
    } else {
      await this.prisma.assetCalculationTerm.updateMany({
        where: { assetId: asset.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }
  }

  private async findActiveAssetDetail(
    model: 'assetMarketPosition' | 'assetCalculationTerm',
    assetId: string,
  ): Promise<DbRow | null> {
    if (model === 'assetMarketPosition') {
      return this.prisma.assetMarketPosition.findFirst({
        where: { assetId, deletedAt: null },
        select: { id: true },
      });
    }

    return this.prisma.assetCalculationTerm.findFirst({
      where: { assetId, deletedAt: null },
      select: { id: true },
    });
  }
}
