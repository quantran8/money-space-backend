import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import { AS_OF } from '../../common/seed/money-space.seed';
import { Asset, AssetValuationMode } from './entities/asset.entity';
import { AssetValuation } from './entities/asset-valuation.entity';
import {
  computeCurrentValue,
  computeLiquidityTotals,
  defaultValuationModeForAssetType,
  formatCompactMillions,
} from '../../common/utils/money-space.utils';
import type { CreateAssetDto } from './dto/create-asset.dto';
import type { UpdateAssetDto } from './dto/update-asset.dto';
import { ASSETS_REPOSITORY } from './repositories/assets.repository.interface';
import type { AssetsRepository } from './repositories/assets.repository.interface';

@Injectable()
export class AssetsService {
  constructor(
    @Inject(ASSETS_REPOSITORY)
    private readonly assetsRepository: AssetsRepository,
    private readonly prisma: PrismaService,
  ) {}

  async listAssets(householdId: string) {
    const household = await this.assetsRepository.assertHousehold(householdId);
    const items = await this.getAssetRecords(householdId);

    return {
      household,
      asOf: AS_OF,
      items,
      total: items.length,
    };
  }

  async getAssetSummary(householdId: string) {
    await this.assetsRepository.assertHousehold(householdId);
    const assets = await this.getAssetRecords(householdId);
    const totals = computeLiquidityTotals(assets);

    return {
      householdId,
      asOf: AS_OF,
      totals,
      groups: [
        {
          liquidity: 'usable_now',
          name: 'Co the dung ngay',
          value: totals.usable_now,
          valueDisplay: formatCompactMillions(totals.usable_now),
        },
        {
          liquidity: 'not_immediately_usable',
          name: 'Tiet kiem & du phong',
          value: totals.not_immediately_usable,
          valueDisplay: formatCompactMillions(totals.not_immediately_usable),
        },
        {
          liquidity: 'long_term',
          name: 'Dai han',
          value: totals.long_term,
          valueDisplay: formatCompactMillions(totals.long_term),
        },
      ],
    };
  }

  async getAssetSnapshots(householdId: string) {
    await this.assetsRepository.assertHousehold(householdId);
    const items =
      await this.assetsRepository.getSnapshotsByHousehold(householdId);

    return {
      householdId,
      items,
      total: items.length,
    };
  }

  async getAssetDetail(householdId: string, assetId: string) {
    await this.assetsRepository.assertHousehold(householdId);
    const asset = (await this.getAssetRecords(householdId)).find(
      (item) => item.id === assetId,
    );
    if (!asset) {
      throw new NotFoundException(`Asset "${assetId}" was not found`);
    }
    return asset;
  }

  async getAssetValuations(householdId: string, assetId: string) {
    await this.ensureAsset(householdId, assetId);
    const items = await this.assetsRepository.findAssetValuations(
      householdId,
      assetId,
    );

    return {
      householdId,
      assetId,
      items,
      total: items.length,
    };
  }

  async createAsset(householdId: string, payload: CreateAssetDto) {
    // `insertAsset` asserts the household exists (and needs its row to resolve
    // `createdById`), so we don't assert it a second time here.
    const asset = this.normalizeAsset({
      id: this.assetsRepository.createId('asset'),
      householdId,
      name: payload.name,
      type: payload.type,
      valuationMode:
        payload.valuationMode ?? defaultValuationModeForAssetType(payload.type),
      liquidity: payload.liquidity,
      currency: payload.currency ?? 'VND',
      note: payload.note ?? '',
      manualValue: payload.manualValue,
      marketPosition: payload.marketPosition,
      calculationTerm: payload.calculationTerm,
    });

    // The asset row and its initial valuation must be written atomically.
    const currentValue = await this.prisma.runInTransaction(async () => {
      await this.assetsRepository.insertAsset(asset);
      return this.upsertCurrentValuation(asset);
    });
    return this.toAssetRecord(asset, currentValue);
  }

  async updateAsset(
    householdId: string,
    assetId: string,
    payload: UpdateAssetDto,
  ) {
    const current = await this.ensureAsset(householdId, assetId);
    const next = this.normalizeAsset({
      ...current,
      ...payload,
      id: current.id,
      householdId: current.householdId,
      valuationMode:
        payload.valuationMode ??
        defaultValuationModeForAssetType(payload.type ?? current.type),
      name: payload.name ?? current.name,
      type: payload.type ?? current.type,
      liquidity: payload.liquidity ?? current.liquidity,
      currency: payload.currency ?? current.currency,
      note: payload.note ?? current.note,
      manualValue:
        payload.manualValue !== undefined
          ? payload.manualValue
          : current.manualValue,
      marketPosition:
        payload.marketPosition !== undefined
          ? payload.marketPosition
          : current.marketPosition,
      calculationTerm:
        payload.calculationTerm !== undefined
          ? payload.calculationTerm
          : current.calculationTerm,
    });

    // The asset row and its valuation update atomically.
    const currentValue = await this.prisma.runInTransaction(async () => {
      await this.assetsRepository.updateAsset(assetId, next);
      return this.upsertCurrentValuation(next);
    });
    return this.toAssetRecord(next, currentValue);
  }

  async deleteAsset(householdId: string, assetId: string) {
    await this.ensureAsset(householdId, assetId);
    // These three writes must all land or none: run them in one transaction,
    // sequentially (they share the transaction's single connection).
    await this.prisma.runInTransaction(async () => {
      await this.assetsRepository.deleteAsset(assetId);
      await this.assetsRepository.deleteAssetValuations(assetId);
      await this.assetsRepository.unlinkAssetFromMoneyEvents(assetId);
    });
    return {
      deleted: true,
      assetId,
    };
  }

  private async getAssetRecords(householdId: string) {
    const [assets, marketPrices, fxRates] = await Promise.all([
      this.assetsRepository.findAssetsByHousehold(householdId),
      this.assetsRepository.getMarketPrices(),
      this.assetsRepository.getFxRates(),
    ]);

    return assets.map((asset) => {
      const currentValue = computeCurrentValue(
        asset,
        marketPrices,
        fxRates,
        AS_OF,
      );
      return {
        ...asset,
        currentValue,
        currentValueDisplay: formatCompactMillions(currentValue),
        valueUpdatedAt: AS_OF,
      };
    });
  }

  private async ensureAsset(householdId: string, assetId: string) {
    await this.assetsRepository.assertHousehold(householdId);
    const asset = await this.assetsRepository.findAssetById(
      householdId,
      assetId,
    );
    if (!asset) {
      throw new NotFoundException(`Asset "${assetId}" was not found`);
    }
    return asset;
  }

  private normalizeAsset(asset: Asset): Asset {
    const next = { ...asset };
    const mode = next.valuationMode;

    if (mode === 'manual') {
      next.marketPosition = undefined;
      next.calculationTerm = undefined;
      next.manualValue = next.manualValue ?? 0;
    }

    if (mode === 'market_priced') {
      next.manualValue = undefined;
      next.calculationTerm = undefined;
    }

    if (mode === 'formula_calculated') {
      next.manualValue = undefined;
      next.marketPosition = undefined;
    }

    return next;
  }

  private toAssetRecord(asset: Asset, currentValue: number) {
    return {
      ...asset,
      currentValue,
      currentValueDisplay: formatCompactMillions(currentValue),
      valueUpdatedAt: AS_OF,
    };
  }

  private async upsertCurrentValuation(asset: Asset): Promise<number> {
    // Called inside the asset create/update transaction (shared connection), so
    // these reads run sequentially rather than concurrently on the same client.
    const marketPrices = await this.assetsRepository.getMarketPrices();
    const fxRates = await this.assetsRepository.getFxRates();
    const value = computeCurrentValue(asset, marketPrices, fxRates, AS_OF);
    const existing = await this.assetsRepository.findAssetValuation(
      asset.id,
      AS_OF,
    );
    const method: AssetValuation['method'] =
      asset.valuationMode === 'manual'
        ? 'manual'
        : asset.valuationMode === 'market_priced'
          ? 'market_price_api'
          : 'formula_calculated';

    if (existing) {
      existing.value = value;
      existing.currency = asset.currency;
      existing.method = method;
      existing.note = asset.note;
      await this.assetsRepository.insertAssetValuation(existing);
      return value;
    }

    await this.assetsRepository.insertAssetValuation({
      id: this.assetsRepository.createId('valuation'),
      assetId: asset.id,
      householdId: asset.householdId,
      valuationDate: AS_OF,
      value,
      currency: asset.currency,
      method,
      note: asset.note,
    });

    return value;
  }
}
