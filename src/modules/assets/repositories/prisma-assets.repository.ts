import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  mapAsset,
  mapAssetValuation,
  mapFxRate,
  mapHousehold,
  mapMarketPrice,
  mapSnapshot,
} from '../../../common/repositories/money-space.mapper';
import {
  DbRow,
  PrismaRepository,
} from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { Asset } from '../entities/asset.entity';
import { AssetValuation } from '../entities/asset-valuation.entity';
import { SnapshotPoint } from '../../dashboard/entities/snapshot-point.entity';
import { Household } from '../../households/entities/household.entity';
import { FxRate } from '../../market-data/entities/fx-rate.entity';
import { MarketPrice } from '../../market-data/entities/market-price.entity';
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
      } as any,
    });
    await this.upsertAssetDetails(asset);
  }

  async deleteAsset(assetId: string): Promise<void> {
    await this.prisma.asset.updateMany({
      where: { id: assetId },
      data: { deletedAt: new Date() },
    });
  }

  async findAssetValuations(
    householdId: string,
    assetId: string,
  ): Promise<AssetValuation[]> {
    const valuations = await this.prisma.assetValuation.findMany({
      where: { householdId, assetId, deletedAt: null },
      orderBy: { valuationDate: 'desc' },
    });

    return valuations.map((valuation) => mapAssetValuation(valuation));
  }

  async findAssetValuation(
    assetId: string,
    valuationDate: string,
  ): Promise<AssetValuation | undefined> {
    const valuation = await this.prisma.assetValuation.findFirst({
      where: {
        assetId,
        valuationDate: this.toDate(valuationDate) ?? undefined,
        deletedAt: null,
      },
    });

    return valuation ? mapAssetValuation(valuation) : undefined;
  }

  async insertAssetValuation(valuation: AssetValuation): Promise<void> {
    const existing = await this.findAssetValuation(
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

  async deleteAssetValuations(assetId: string): Promise<void> {
    await this.prisma.assetValuation.updateMany({
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

  async getSnapshotsByHousehold(householdId: string): Promise<SnapshotPoint[]> {
    const snapshots = await this.prisma.snapshot.findMany({
      where: { householdId, deletedAt: null },
      orderBy: { snapshotDate: 'asc' },
    });

    return snapshots.map((snapshot) => mapSnapshot(snapshot));
  }

  async getMarketPrices(): Promise<MarketPrice[]> {
    const prices = await this.prisma.marketPrice.findMany({
      orderBy: { priceTime: 'desc' },
    });

    return prices.map((price) => mapMarketPrice(price));
  }

  async getFxRates(): Promise<FxRate[]> {
    const rates = await this.prisma.fxRate.findMany({
      orderBy: { rateTime: 'desc' },
    });

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
