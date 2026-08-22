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
   * Record an acquisition, linked to the asset through `toAssetId` so it shows
   * in both the household ledger and the asset activity timeline.
   *
   * `fundingAssetId` decides which act this is: a wallet means a purchase
   * (`outflow` from it — the caller debits it, leaving net worth unchanged);
   * omitting it means the household is declaring something it already owns
   * (`neutral`, no source, no balance touched). See `CreateAssetDto`.
   */
  insertAssetPurchaseEvent(event: {
    id: string;
    householdId: string;
    assetId: string;
    amount: number;
    isoDate: string;
    note: string;
    fundingAssetId?: string | null;
  }): Promise<void>;
  updateAsset(assetId: string, asset: Asset): Promise<void>;
  updateAssetCurrentValue(assetId: string, value: number): Promise<void>;
  /**
   * Bump `value_updated_at` on the given assets (all active ones when the list
   * is empty) without changing any value. Returns how many rows were touched.
   */
  confirmAssetsUnchanged(
    householdId: string,
    assetIds: string[],
  ): Promise<number>;
  deleteAsset(assetId: string): Promise<void>;
  /**
   * Soft-delete the asset's own detail rows — its market position and its
   * calculation term.
   *
   * They belong to the asset and describe nothing else, so they go with it.
   * Prisma's `onDelete: Cascade` on both relations never fires here because the
   * asset is only soft-deleted, which is how a deleted holding's ticker stayed
   * in the market-data poll universe.
   */
  deleteAssetDetails(assetId: string): Promise<void>;
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
   * Bulk equivalent of {@link insertAssetValueHistory} for the daily market
   * revaluation: writes every asset's dated cache point in ONE statement
   * instead of a lookup + write per asset. Only for unlinked
   * (`moneyEventId`-less) points — the event-linked path keeps its own upsert.
   */
  upsertMarketValuationPoints(valuations: AssetValueHistory[]): Promise<void>;
  /** Bulk `current_value` write, one statement for many assets. */
  updateAssetCurrentValues(
    values: Array<{ assetId: string; value: number }>,
  ): Promise<void>;
  /**
   * Whether any market-priced valuation point already exists for this household
   * on the given date — the gate for the once-per-day dashboard-triggered
   * refresh, so a household is re-priced at most once per day.
   */
  /**
   * Households holding at least one active market-priced asset that has NOT
   * been re-priced on `valuationDate` yet — the work list for the daily job.
   *
   * Filtered in SQL rather than by loading every household and checking each:
   * the job must not scan households it has nothing to do for, and the "already
   * done today" check has to be part of the same query or it becomes one
   * round-trip per household.
   */
  findHouseholdsNeedingMarketValuation(
    valuationDate: string,
    limit: number,
  ): Promise<string[]>;
  hasMarketValuationOnDate(
    householdId: string,
    valuationDate: string,
  ): Promise<boolean>;
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
