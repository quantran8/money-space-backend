import { Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '../../../common/utils/uuid';
import {
  mapAsset,
  mapAssetValueHistory,
  mapFxRate,
  mapHousehold,
  mapMarketPrice,
  mapMoneyEvent,
  mapSnapshot,
} from '../../../common/repositories/money-space.mapper';
import {
  DbRow,
  PrismaRepository,
} from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { Asset } from '../entities/asset.entity';
import { AssetValueHistory } from '../entities/asset-value-history.entity';
import { SnapshotPoint } from '../../dashboard/entities/snapshot-point.entity';
import { Household } from '../../households/entities/household.entity';
import { FxRate } from '../../market-data/entities/fx-rate.entity';
import { MarketPrice } from '../../market-data/entities/market-price.entity';
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
        (id, household_id, name, type, valuation_mode, current_value,
         currency, value_updated_at, liquidity, note, created_by, updated_at)
      SELECT
        ${asset.id}::uuid,
        h.id,
        ${asset.name},
        ${asset.type}::"AssetType",
        ${asset.valuationMode}::"AssetValuationMode",
        ${currentValue}::numeric,
        ${asset.currency},
        now(),
        ${asset.liquidity}::"AssetLiquidity",
        ${asset.note},
        h.created_by,
        now()
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
    title: string;
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
        (id, household_id, title, description, event_type, category, amount,
         fee_amount, currency, event_date, direction, to_asset_id,
         created_by, updated_at)
      SELECT
        ${event.id}::uuid,
        h.id,
        ${event.title},
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
        note: asset.note,
        status: asset.status,
        soldAt: asset.soldAt ? new Date(asset.soldAt) : null,
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

  async deleteAsset(assetId: string): Promise<void> {
    await this.prisma.asset.updateMany({
      where: { id: assetId },
      data: { deletedAt: new Date() },
    });
  }

  async findAssetValueHistoryByAsset(
    householdId: string,
    assetId: string,
  ): Promise<AssetValueHistory[]> {
    const valuations = await this.prisma.assetValueHistory.findMany({
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
    const valuation = await this.prisma.assetValueHistory.findFirst({
      where: {
        assetId,
        valuationDate: this.toDate(valuationDate) ?? undefined,
        moneyEventId: null,
        deletedAt: null,
      },
    });

    return valuation ? mapAssetValueHistory(valuation) : undefined;
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
      marketPriceId: valuation.marketPriceId ?? null,
      fxRateId: valuation.fxRateId ?? null,
      calculationTermId: valuation.calculationTermId ?? null,
      deletedAt: null,
    } as any;

    if (existing) {
      await this.prisma.assetValueHistory.update({
        where: { id: existing.id },
        data,
      });
      return;
    }

    await this.prisma.assetValueHistory.create({
      data: { id: valuation.id, ...data },
    });
  }

  async findAssetValueHistoryByMoneyEvent(
    moneyEventId: string,
    assetId: string,
  ): Promise<AssetValueHistory | undefined> {
    const valuation = await this.prisma.assetValueHistory.findFirst({
      where: { moneyEventId, assetId, deletedAt: null },
    });

    return valuation ? mapAssetValueHistory(valuation) : undefined;
  }

  async deleteAssetValueHistoryByMoneyEvent(
    moneyEventId: string,
  ): Promise<void> {
    await this.prisma.assetValueHistory.updateMany({
      where: { moneyEventId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  async deleteAssetValueHistory(assetId: string): Promise<void> {
    await this.prisma.assetValueHistory.updateMany({
      where: { assetId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  async unlinkAssetFromMoneyEvents(assetId: string): Promise<void> {
    // Runs inside the asset delete transaction (shared connection), so the two
    // updates run sequentially rather than concurrently on the same client.
    await this.prisma.moneyEvent.updateMany({
      where: { fromAssetId: assetId },
      data: { fromAssetId: null },
    });
    await this.prisma.moneyEvent.updateMany({
      where: { toAssetId: assetId },
      data: { toAssetId: null },
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

  async getMarketPrices(): Promise<MarketPrice[]> {
    const prices = await this.findLatestMarketPrices();
    return prices.map((price) => mapMarketPrice(price));
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
        quantity: asset.marketPosition.quantity,
        unit: asset.marketPosition.unit,
        quoteCurrency: asset.marketPosition.quoteCurrency,
        unitPrice: asset.marketPosition.unitPrice ?? null,
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
