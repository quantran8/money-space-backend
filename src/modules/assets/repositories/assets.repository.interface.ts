import type { Asset } from '../entities/asset.entity';
import type { AssetValuation } from '../entities/asset-valuation.entity';
import type { SnapshotPoint } from '../../dashboard/entities/snapshot-point.entity';
import type { Household } from '../../households/entities/household.entity';
import type { FxRate } from '../../market-data/entities/fx-rate.entity';
import type { MarketPrice } from '../../market-data/entities/market-price.entity';
import type { MoneyEvent } from '../../money-events/entities/money-event.entity';

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
  updateAssetCurrentValue(assetId: string, value: number): Promise<void>;
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
  /**
   * Money events that moved value in or out of this asset — i.e. it is the
   * `fromAsset` or `toAsset` of the event. Ordered oldest → newest so the
   * caller can walk them chronologically. Used to reconstruct value history.
   */
  findMoneyEventsByAsset(
    householdId: string,
    assetId: string,
  ): Promise<MoneyEvent[]>;
  getSnapshotsByHousehold(householdId: string): Promise<SnapshotPoint[]>;
  getMarketPrices(): Promise<MarketPrice[]>;
  getFxRates(): Promise<FxRate[]>;
}
