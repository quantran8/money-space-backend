import type { Asset, AssetClass } from '../entities/asset.entity';
import type { AssetValueHistory } from '../entities/asset-value-history.entity';
import type { SnapshotPoint } from '../../dashboard/entities/snapshot-point.entity';
import type { Household } from '../../households/entities/household.entity';
import type { FxRate } from '../../market-data/entities/fx-rate.entity';
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
  /** Active market asset with the same class + symbol (case-insensitive). */
  findActiveMarketAssetBySymbol(
    householdId: string,
    assetClass: AssetClass,
    symbol: string,
  ): Promise<Asset | undefined>;
  insertAsset(asset: Asset): Promise<void>;
  /**
   * Log a direct re-pricing of an asset as a neutral `asset_update` money event
   * linked to the asset (via `toAssetId`). Records why the value changed for
   * history without moving a wallet or counting as income/expense. `amount` is
   * the signed value delta (new − old).
   */
  insertRevaluationEvent(event: {
    id: string;
    householdId: string;
    assetId: string;
    amount: number;
    isoDate: string;
    note?: string;
  }): Promise<void>;
  /**
   * Record an additional buy merged into an existing market position. The
   * event is neutral (it does not imply a wallet source) and links to the
   * position through `toAssetId`, so it appears in both the household ledger
   * and the asset activity timeline.
   */
  insertAssetPurchaseEvent(event: {
    id: string;
    householdId: string;
    assetId: string;
    amount: number;
    isoDate: string;
    note: string;
  }): Promise<void>;
  updateAsset(assetId: string, asset: Asset): Promise<void>;
  updateAssetCurrentValue(assetId: string, value: number): Promise<void>;
  deleteAsset(assetId: string): Promise<void>;
  findAssetValueHistoryByAsset(
    householdId: string,
    assetId: string,
  ): Promise<AssetValueHistory[]>;
  findAssetValueHistory(
    assetId: string,
    valuationDate: string,
  ): Promise<AssetValueHistory | undefined>;
  insertAssetValueHistory(valuation: AssetValueHistory): Promise<void>;
  /**
   * The active valuation record a given money event produced for a given asset,
   * if any. One event can touch several assets (a transfer values both wallets),
   * so this is keyed on both. Used to update the exact record when an event is
   * edited.
   */
  findAssetValueHistoryByMoneyEvent(
    moneyEventId: string,
    assetId: string,
  ): Promise<AssetValueHistory | undefined>;
  deleteAssetValueHistory(assetId: string): Promise<void>;
  /**
   * Soft-delete every valuation record a money event produced. Called when the
   * event is deleted, so the value points it created disappear from history.
   */
  deleteAssetValueHistoryByMoneyEvent(moneyEventId: string): Promise<void>;
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
  getFxRates(): Promise<FxRate[]>;
}
