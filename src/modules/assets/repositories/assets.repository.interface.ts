import type { Asset } from '../entities/asset.entity';
import type { AssetValuation } from '../entities/asset-valuation.entity';
import type { SnapshotPoint } from '../../dashboard/entities/snapshot-point.entity';
import type { Household } from '../../households/entities/household.entity';
import type { FxRate } from '../../market-data/entities/fx-rate.entity';
import type { MarketPrice } from '../../market-data/entities/market-price.entity';

export const ASSETS_REPOSITORY = Symbol('ASSETS_REPOSITORY');

export interface AssetsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  findAssetsByHousehold(householdId: string): Promise<Asset[]>;
  findAssetById(
    householdId: string,
    assetId: string,
  ): Promise<Asset | undefined>;
  insertAsset(asset: Asset): Promise<void>;
  updateAsset(assetId: string, asset: Asset): Promise<void>;
  deleteAsset(assetId: string): Promise<void>;
  findAssetValuations(
    householdId: string,
    assetId: string,
  ): Promise<AssetValuation[]>;
  findAssetValuation(
    assetId: string,
    valuationDate: string,
  ): Promise<AssetValuation | undefined>;
  insertAssetValuation(valuation: AssetValuation): Promise<void>;
  deleteAssetValuations(assetId: string): Promise<void>;
  unlinkAssetFromMoneyEvents(assetId: string): Promise<void>;
  getSnapshotsByHousehold(householdId: string): Promise<SnapshotPoint[]>;
  getMarketPrices(): Promise<MarketPrice[]>;
  getFxRates(): Promise<FxRate[]>;
}
