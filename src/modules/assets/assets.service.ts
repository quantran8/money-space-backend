import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import { AS_OF } from '../../common/seed/money-space.seed';
import { Asset, AssetType } from './entities/asset.entity';

/**
 * Asset types that hold a free, spendable cash balance ("wallets"). Only these
 * are credited/debited when a money event moves money in or out of them — a
 * market-priced or formula-valued asset (stock, gold, saving deposit, …) is
 * valued from its price/formula, not by adding cash to a stored balance.
 */
const WALLET_ASSET_TYPES: ReadonlySet<AssetType> = new Set<AssetType>([
  'cash',
  'bank_account',
]);
import { AssetValueHistory } from './entities/asset-value-history.entity';
import type { MoneyEvent } from '../money-events/entities/money-event.entity';
import {
  computeCurrentValue,
  computeLiquidityTotals,
  defaultValuationModeForAssetType,
} from '../../common/utils/money-space.utils';
import type { CreateAssetDto } from './dto/create-asset.dto';
import type { UpdateAssetDto } from './dto/update-asset.dto';
import { ASSETS_REPOSITORY } from './repositories/assets.repository.interface';
import type { AssetsRepository } from './repositories/assets.repository.interface';
import { SnapshotsService } from '../snapshots/snapshots.service';
import { MarketDataService } from '../market-data/market-data.service';

/**
 * Ties a valuation write back to the money event that caused it, so the value
 * point lands in history linked to that event (and dated at the event's date).
 * Absent for changes with no event origin (a plain asset create/update writes
 * only the AS_OF cache row).
 */
export interface ValuationContext {
  moneyEventId?: string;
  valuationDate?: string;
}

@Injectable()
export class AssetsService {
  constructor(
    @Inject(ASSETS_REPOSITORY)
    private readonly assetsRepository: AssetsRepository,
    private readonly prisma: PrismaService,
    private readonly snapshots: SnapshotsService,
    private readonly marketData: MarketDataService,
  ) {}

  private readonly logger = new Logger(AssetsService.name);
  /** Households with a dashboard-triggered refresh in flight, to de-dup concurrent hits. */
  private readonly refreshInFlight = new Set<string>();

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
    // A sold/closed asset no longer contributes to net worth or the liquidity
    // buckets — it is kept only for history. See [[asset-sale]].
    const activeAssets = assets.filter((asset) => asset.status === 'active');
    const totals = computeLiquidityTotals(activeAssets);

    return {
      householdId,
      asOf: AS_OF,
      totals,
      groups: [
        {
          liquidity: 'usable_now',
          name: 'Co the dung ngay',
          value: totals.usable_now,
        },
        {
          liquidity: 'not_immediately_usable',
          name: 'Tiet kiem & du phong',
          value: totals.not_immediately_usable,
        },
        {
          liquidity: 'long_term',
          name: 'Dai han',
          value: totals.long_term,
        },
      ],
    };
  }

  /**
   * Daily/external-worker entry point: refresh provider cache once, then persist
   * one value-history point per active market asset for today.
   */
  async refreshMarketValuations(householdId: string) {
    await this.assetsRepository.assertHousehold(householdId);
    const [assets, marketPrices, fxRates] = await Promise.all([
      this.assetsRepository.findAssetsByHousehold(householdId),
      this.marketData.getMarketPrices(true),
      this.assetsRepository.getFxRates(),
    ]);
    const marketAssets = assets.filter(
      (asset) =>
        asset.status === 'active' &&
        asset.valuationMode === 'market_priced' &&
        !!asset.marketPosition,
    );
    await this.prisma.runInTransaction(async () => {
      for (const asset of marketAssets) {
        const value = computeCurrentValue(asset, marketPrices, fxRates, AS_OF);
        await this.assetsRepository.insertAssetValueHistory({
          id: this.assetsRepository.createId('valuation'),
          assetId: asset.id,
          householdId,
          valuationDate: this.todayIso(),
          value,
          currency: asset.currency,
          note: `Định giá định kỳ: ${asset.name}`,
          ...this.valuationLineage(asset),
        });
        await this.assetsRepository.updateAssetCurrentValue(asset.id, value);
      }
    });
    for (const asset of marketAssets) {
      await this.snapshots.onAssetChanged(householdId, asset.id);
    }
    return {
      householdId,
      refreshed: marketAssets.length,
      asOf: this.todayIso(),
    };
  }

  /**
   * Once-per-day, dashboard-triggered price refresh. Called fire-and-forget when
   * a household opens the dashboard: if its market assets were not already
   * repriced today it runs {@link refreshMarketValuations}, otherwise it no-ops.
   * De-duplicates concurrent dashboard hits with an in-process in-flight guard so
   * two tabs loading at once don't double-refresh. Never throws — callers do not
   * await it; failures are logged and the dashboard still returns cached prices.
   */
  async refreshMarketValuationsIfStale(
    householdId: string,
  ): Promise<{ refreshed: number; skipped: boolean } | undefined> {
    if (this.refreshInFlight.has(householdId)) {
      return { refreshed: 0, skipped: true };
    }
    this.refreshInFlight.add(householdId);
    try {
      const alreadyRefreshed =
        await this.assetsRepository.hasMarketValuationOnDate(
          householdId,
          this.todayIso(),
        );
      if (alreadyRefreshed) {
        return { refreshed: 0, skipped: true };
      }
      const result = await this.refreshMarketValuations(householdId);
      return { refreshed: result.refreshed, skipped: false };
    } catch (error) {
      this.logger.error(
        `Daily market refresh failed for household ${householdId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    } finally {
      this.refreshInFlight.delete(householdId);
    }
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

  async getAssetValueHistoryPoints(householdId: string, assetId: string) {
    await this.ensureAsset(householdId, assetId);
    const items = await this.assetsRepository.findAssetValueHistoryByAsset(
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

  /**
   * Soft-delete the valuation history points a money event produced. Called when
   * that event is deleted so the value points it created disappear from history.
   * Must run inside the caller's transaction (the event delete owns atomicity),
   * and AFTER any wallet-effect reversal — reversal re-touches the linked record
   * with the same event id, so removing it last leaves history clean.
   */
  async removeValuationsForEvent(moneyEventId: string): Promise<void> {
    await this.assetsRepository.deleteAssetValueHistoryByMoneyEvent(
      moneyEventId,
    );
  }

  /**
   * The asset's value over time. Read straight from the persisted
   * `asset_value_history` series — every value-changing action (a money event's
   * wallet/sale effect, or a direct revaluation) appends a dated point there,
   * linked to the money event that caused it.
   *
   * Fallback for an asset created before the series existed (no persisted
   * points): reconstruct it by unwinding the asset's money events backwards from
   * today's value. How a value is recovered then depends on the valuation mode:
   *
   * - **market_priced** — the value is `quantity × unit price` from the
   *   `asset_market_positions` row, so we price the *position*, not the cash the
   *   events moved. We rebuild the quantity held at each point (a sale reduces it
   *   by `soldQuantity`) and value it at the current unit price
   *   (`currentValue / currentQuantity`). This keeps the curve on a consistent
   *   price basis — a sale drops the line by the quantity sold × today's price,
   *   not by the (possibly stale) cash amount the sale fetched.
   * - **manual / formula** — no position, so we unwind the events' signed cash
   *   contribution (in via `toAsset` = +, out via `fromAsset` = −).
   *
   * Result is ordered oldest → newest; the last point is the current value.
   */
  async getAssetValueHistory(householdId: string, assetId: string) {
    const asset = await this.getAssetDetail(householdId, assetId);
    const currentValue = asset.currentValue ?? 0;

    // Primary source: the persisted valuation series. Every value-changing
    // action now appends a dated point here (money events + direct
    // revaluations), so we read it straight rather than reconstructing.
    const valuations = await this.assetsRepository.findAssetValueHistoryByAsset(
      householdId,
      assetId,
    );

    // Collapse duplicate dates, keeping the last value recorded on a day.
    const byDate = new Map<string, number>();
    if (valuations.length > 0) {
      for (const valuation of valuations) {
        byDate.set(valuation.valuationDate, valuation.value);
      }
    } else {
      // Fallback for assets written before the series existed (no persisted
      // points): reconstruct from money events, as before. See [[asset-valuation]].
      const events = await this.assetsRepository.findMoneyEventsByAsset(
        householdId,
        assetId,
      );
      const points =
        asset.valuationMode === 'market_priced' && asset.marketPosition
          ? this.buildMarketValueHistory(asset, currentValue, events)
          : this.buildCashValueHistory(assetId, currentValue, events);
      for (const point of points) {
        byDate.set(point.date, point.value);
      }
    }

    const items = [...byDate.entries()]
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    return {
      householdId,
      assetId,
      currentValue,
      items,
      total: items.length,
    };
  }

  /**
   * Value a market-priced asset's position back through time. The quantity held
   * before a sale is higher by its `soldQuantity`; every point is priced at the
   * current unit price so the curve reflects the position, not the cash moved.
   */
  private buildMarketValueHistory(
    asset: Asset,
    currentValue: number,
    events: MoneyEvent[],
  ): Array<{ date: string; value: number }> {
    const currentQuantity = asset.marketPosition?.quantity ?? 0;
    // Unit price implied by the current position; 0 quantity → no basis to price
    // history, so fall back to a flat current-value point.
    const currentUnitPrice =
      currentQuantity > 0 ? currentValue / currentQuantity : 0;

    const points: Array<{ date: string; value: number }> = [
      { date: AS_OF, value: currentValue },
    ];

    let quantity = currentQuantity;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      // Only sales out of this asset changed the quantity held. (Purchases set
      // the quantity directly on the asset, not through a money event.)
      if (event.type === 'asset_sale' && event.fromAssetId === asset.id) {
        quantity += event.soldQuantity ?? 0;
        points.push({
          date: event.isoDate,
          value: Math.max(0, quantity * currentUnitPrice),
        });
      }
    }
    points.reverse();
    return points;
  }

  /**
   * Unwind the signed cash contribution of each event for manual/formula assets:
   * value in (`toAsset`) is positive, out (`fromAsset`) is negative.
   */
  private buildCashValueHistory(
    assetId: string,
    currentValue: number,
    events: MoneyEvent[],
  ): Array<{ date: string; value: number }> {
    const changes = events
      .map((event) => {
        const magnitude = Math.abs(event.amount);
        const signed =
          event.toAssetId === assetId
            ? magnitude
            : event.fromAssetId === assetId
              ? -magnitude
              : 0;
        return { isoDate: event.isoDate, amount: signed };
      })
      .filter((change) => change.amount !== 0);

    const points: Array<{ date: string; value: number }> = [
      { date: AS_OF, value: currentValue },
    ];
    let running = currentValue;
    for (let i = changes.length - 1; i >= 0; i -= 1) {
      running -= changes[i].amount;
      points.push({ date: changes[i].isoDate, value: Math.max(0, running) });
    }
    points.reverse();
    return points;
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
      status: 'active',
      areaSqm: payload.areaSqm,
      manualValue: payload.manualValue,
      marketPosition: payload.marketPosition,
      calculationTerm: payload.calculationTerm,
    });

    // The asset row and its initial valuation must be written atomically. When
    // the household already has an active position for the same class+symbol,
    // add to that position and recompute weighted-average purchase price rather
    // than creating a duplicate asset row.
    // A brand-new asset does not log a money event — it establishes the opening
    // position. Adding quantity to an existing class+symbol is different: it is
    // a real additional purchase, so that merge logs a neutral asset_purchase
    // event (no funding wallet was selected) and links the new valuation to it.
    const result = await this.prisma.runInTransaction(async () => {
      if (asset.marketPosition) {
        const incoming = asset.marketPosition;
        const existing =
          await this.assetsRepository.findActiveMarketAssetBySymbol(
            householdId,
            incoming.assetClass,
            incoming.symbol,
          );
        if (existing?.marketPosition) {
          const held = existing.marketPosition;
          const quantity = held.quantity + incoming.quantity;
          const heldCost = held.purchasePrice ?? 0;
          const incomingCost = incoming.purchasePrice ?? 0;
          const purchasePrice =
            quantity > 0
              ? (held.quantity * heldCost + incoming.quantity * incomingCost) /
                quantity
              : heldCost;
          const merged: Asset = {
            ...existing,
            marketPosition: {
              ...held,
              quantity,
              purchasePrice,
            },
          };
          await this.assetsRepository.updateAsset(existing.id, merged);
          const context = await this.logAdditionalPurchase(merged, incoming);
          const value = await this.upsertCurrentValuation(merged, context);
          return { asset: merged, currentValue: value };
        }
      }
      await this.assetsRepository.insertAsset(asset);
      const currentValue = await this.writeInitialValuation(asset);
      return { asset, currentValue };
    });
    await this.snapshots.onAssetChanged(householdId, result.asset.id);
    return this.toAssetRecord(result.asset, result.currentValue);
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
      areaSqm:
        payload.areaSqm !== undefined ? payload.areaSqm : current.areaSqm,
      manualValue:
        payload.manualValue !== undefined
          ? payload.manualValue
          : current.manualValue,
      marketPosition:
        payload.marketPosition !== undefined
          ? {
              ...current.marketPosition,
              ...payload.marketPosition,
            }
          : current.marketPosition,
      calculationTerm:
        payload.calculationTerm !== undefined
          ? payload.calculationTerm
          : current.calculationTerm,
    });

    // Persist the asset and its valuation atomically. Updating only the latest
    // market price is a quote refresh, not a ledger event: it writes an unlinked
    // history point. Changes to cost basis/position or another valuation source
    // still create a neutral `asset_update` event.
    const oldValue = await this.computeValueAsync(current);
    const currentValue = await this.prisma.runInTransaction(async () => {
      await this.assetsRepository.updateAsset(assetId, next);
      const value = await this.computeValueAsync(next);
      const valueChanged = value !== oldValue;
      const latestMarketPriceOnly =
        valueChanged && this.isLatestMarketPriceOnlyUpdate(current, next);
      if (latestMarketPriceOnly) {
        await this.writeLatestMarketPricePoint(next, value);
      }
      const context =
        valueChanged && !latestMarketPriceOnly
          ? await this.logRevaluation(next, oldValue, value, 'Định giá lại')
          : undefined;
      return this.upsertCurrentValuation(next, context);
    });
    await this.snapshots.onAssetChanged(householdId, assetId);
    return this.toAssetRecord(next, currentValue);
  }

  /**
   * Compute an asset's current value the same way `upsertCurrentValuation` does,
   * so revaluation-delta detection and the persisted point can never diverge.
   */
  private async computeValueAsync(asset: Asset): Promise<number> {
    const marketPrices = await this.marketData.getMarketPrices();
    const fxRates = await this.assetsRepository.getFxRates();
    return computeCurrentValue(asset, marketPrices, fxRates, AS_OF);
  }

  /** Today's date (YYYY-MM-DD), the date a user's direct re-pricing is stamped
   *  with — the UI has no date picker, so a revaluation is "as of now". Kept
   *  separate from the seed `AS_OF` constant (used for value computation). */
  private todayIso(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Whether a market asset changed only because its latest observed price was
   * refreshed. Cost basis (`purchasePrice`) and position identity/quantity are
   * deliberately compared; changing any of them remains a ledger-visible
   * revaluation and creates `asset_update`.
   */
  private isLatestMarketPriceOnlyUpdate(current: Asset, next: Asset): boolean {
    if (
      current.valuationMode !== 'market_priced' ||
      next.valuationMode !== 'market_priced' ||
      !current.marketPosition ||
      !next.marketPosition
    ) {
      return false;
    }
    const before = current.marketPosition;
    const after = next.marketPosition;
    const positionUnchanged =
      before.assetClass === after.assetClass &&
      before.symbol === after.symbol &&
      before.quantity === after.quantity &&
      before.unit === after.unit &&
      before.quoteCurrency === after.quoteCurrency &&
      before.purchasePrice === after.purchasePrice;
    const latestPriceChanged =
      before.lastPrice !== after.lastPrice ||
      before.lastPriceAt !== after.lastPriceAt;
    return positionUnchanged && latestPriceChanged;
  }

  /** Record a user-entered current market price without manufacturing a money event. */
  private async writeLatestMarketPricePoint(
    asset: Asset,
    value: number,
  ): Promise<void> {
    await this.writeUnlinkedValuationPoint(
      asset,
      value,
      `Cập nhật giá thị trường: ${asset.name}`,
      { method: 'manual', source: 'user', confidenceLevel: 'high' },
    );
  }

  /** Write/update the one unlinked value-history point for an asset on today. */
  private async writeUnlinkedValuationPoint(
    asset: Asset,
    value: number,
    note: string,
    lineage = this.valuationLineage(asset),
  ): Promise<void> {
    await this.assetsRepository.insertAssetValueHistory({
      id: this.assetsRepository.createId('valuation'),
      assetId: asset.id,
      householdId: asset.householdId,
      valuationDate: this.todayIso(),
      value,
      currency: asset.currency,
      note,
      ...lineage,
    });
  }

  /**
   * Log a direct re-pricing of an asset as a neutral `asset_update` money event
   * and return the {@link ValuationContext} that links the resulting valuation
   * point to it. The event + point are dated **today** (the re-price happens
   * now; the update UI offers no date picker). Runs inside the caller's
   * transaction. Returns `undefined` (no event, no linked point) when the value
   * did not move.
   */
  private async logRevaluation(
    asset: Asset,
    oldValue: number,
    newValue: number,
    reason: string,
  ): Promise<ValuationContext | undefined> {
    if (newValue === oldValue) {
      return undefined;
    }
    const today = this.todayIso();
    const eventId = this.assetsRepository.createId('event');
    // `title` was dropped from money events; the descriptive label now lives in
    // the event's note (description). Prefix the asset's own note with it so the
    // history entry still reads "Định giá lại: <asset>" without a separate column.
    const label = `${reason}: ${asset.name}`;
    const note = asset.note ? `${label} — ${asset.note}` : label;
    await this.assetsRepository.insertRevaluationEvent({
      id: eventId,
      householdId: asset.householdId,
      assetId: asset.id,
      amount: newValue - oldValue,
      isoDate: today,
      note,
    });
    return { moneyEventId: eventId, valuationDate: today };
  }

  /**
   * Log quantity merged into an existing market position as an
   * `asset_purchase`. It is deliberately neutral because this form does not
   * select a source wallet; the amount is the added position's cost basis and
   * `toAssetId` links the event to the resulting asset.
   */
  private async logAdditionalPurchase(
    asset: Asset,
    incoming: NonNullable<Asset['marketPosition']>,
  ): Promise<ValuationContext> {
    const today = this.todayIso();
    const eventId = this.assetsRepository.createId('event');
    const purchaseAmount = Math.max(
      0,
      incoming.quantity * (incoming.purchasePrice ?? 0),
    );
    const quantityLabel = new Intl.NumberFormat('vi-VN', {
      maximumFractionDigits: 8,
    }).format(incoming.quantity);
    const note = `Mua thêm ${quantityLabel} ${incoming.unit || 'đơn vị'} ${incoming.symbol}`;
    await this.assetsRepository.insertAssetPurchaseEvent({
      id: eventId,
      householdId: asset.householdId,
      assetId: asset.id,
      amount: purchaseAmount,
      isoDate: today,
      note,
    });
    return { moneyEventId: eventId, valuationDate: today };
  }

  /**
   * Re-apply an edited revaluation (`asset_update`) event: set the asset's value
   * to `newValue` and keep its linked history point + `current_value` cache in
   * sync, so editing the amount of a "Định giá lại" event actually re-prices the
   * asset (two-way sync). Returns the resolved value. Runs inside the caller's
   * transaction (the money-event update owns atomicity).
   *
   * For a manual asset the value is stored in `manualValue`; for a
   * market/formula asset there is no free value to set, so only the cache +
   * history point are updated (the derived value still comes from price/formula).
   */
  async applyRevaluationEdit(
    householdId: string,
    assetId: string,
    newValue: number,
    context: ValuationContext,
  ): Promise<number> {
    const asset = await this.ensureAsset(householdId, assetId);
    if (asset.valuationMode === 'manual') {
      const next: Asset = { ...asset, manualValue: newValue };
      await this.assetsRepository.updateAsset(assetId, next);
      // upsertCurrentValuation recomputes (manual → manualValue) and writes the
      // event-linked history point + current_value cache.
      return this.upsertCurrentValuation(next, context);
    }
    // Non-manual: can't override a price/formula-derived value. Refresh the
    // linked point + cache at the current derived value instead.
    return this.upsertCurrentValuation(asset, context);
  }

  /**
   * Re-apply an edited revaluation (`asset_update`) event **by its delta**, not by
   * overwriting an absolute value. Editing a "Định giá lại" record means editing
   * the *change* it recorded (e.g. −0,5tr), and the edit must:
   *
   * 1. **Adjust the asset's running balance by how much the diff itself moved**
   *    (`deltaChange = newDelta − oldDelta`), never clobber it with an absolute
   *    number. So a wallet at 6,5tr whose −0,5tr revaluation is re-entered as
   *    −1tr drops to 6tr (6,5 + (−1 − (−0,5))), leaving every later inflow/outflow
   *    that stacked on top of it intact — the balance re-bases automatically.
   * 2. **Re-stamp this record's own history point at the value it produced *at its
   *    date*** — `valueBeforeEvent + newDelta` (the balance just after this
   *    revaluation applied), not the current "now" balance. `valueBeforeEvent` is
   *    the value the asset held immediately before this record.
   *
   * For a **manual** asset the running balance lives in `manualValue`, so we bump
   * it by `deltaChange`. For a market/formula asset there is no free value to
   * shift (the value is derived), so we only re-stamp the record's point at the
   * value-before-event + newDelta and leave the derived `current_value` alone.
   *
   * Returns the asset's resolved `current_value` after the adjustment. Runs inside
   * the caller's transaction (the money-event update owns atomicity).
   */
  async applyRevaluationDeltaEdit(
    householdId: string,
    assetId: string,
    params: {
      moneyEventId: string;
      eventDate: string;
      oldDelta: number;
      newDelta: number;
    },
    context: ValuationContext,
  ): Promise<number> {
    const asset = await this.ensureAsset(householdId, assetId);
    const { moneyEventId, eventDate, oldDelta, newDelta } = params;
    const deltaChange = newDelta - oldDelta;
    // Value the asset held immediately BEFORE this record applied — needed to
    // stamp the record's history point at its date. It is NOT `current − oldDelta`
    // when later events moved the balance past this record: for the running
    // balance B = base + Σ(all events), the value before this record is
    //   B − oldDelta − Σ(events strictly AFTER this record).
    // So subtract this record's own diff and every later event's signed cash
    // contribution from the current balance. (This record already carries its NEW
    // amount in the DB by now, so exclude it by id and use `oldDelta` explicitly.)
    const runningBalance =
      asset.valuationMode === 'manual' ? (asset.manualValue ?? 0) : 0;
    const laterContribution = await this.sumEventContributionsAfter(
      householdId,
      assetId,
      moneyEventId,
      eventDate,
    );
    const valueBeforeEvent = runningBalance - oldDelta - laterContribution;
    // The value this record produced at its own date (used for its history point).
    const valueAtEvent = valueBeforeEvent + newDelta;

    if (asset.valuationMode === 'manual') {
      // Shift the running balance by how much the diff moved — do NOT overwrite.
      const nextBalance = (asset.manualValue ?? 0) + deltaChange;
      const next: Asset = { ...asset, manualValue: nextBalance };
      await this.assetsRepository.updateAsset(assetId, next);
      // Re-stamp this record's point at the value AT its date, then refresh the
      // `current_value` cache to the new running balance.
      await this.writeLinkedValuationPoint(next, valueAtEvent, context);
      await this.assetsRepository.updateAssetCurrentValue(assetId, nextBalance);
      return nextBalance;
    }

    // Non-manual: the value is price/formula-derived and can't be shifted by a
    // manual diff. Only re-stamp the record's own point at the value-at-date; the
    // derived `current_value` stays whatever the price/formula produces.
    await this.writeLinkedValuationPoint(asset, valueAtEvent, context);
    return this.upsertCurrentValuation(asset);
  }

  /**
   * Sum the signed cash contribution to `assetId` of every money event dated
   * **strictly after** `afterDate`, excluding the event `excludeEventId`. Used to
   * recover the asset's balance just before a back-dated revaluation record (the
   * running balance minus this record's own diff minus everything that landed
   * after it).
   *
   * Contribution rules mirror `applyWalletEffects` / value-history reconstruction:
   * - a normal event crediting this asset (`toAssetId`) adds `amount − feeAmount`;
   *   debiting it (`fromAssetId`) subtracts it;
   * - an `asset_update` revaluation stores a **signed delta** in `amount` (linked
   *   via `toAssetId`), so its contribution is that delta as-is (not its
   *   magnitude) — a −0,5tr revaluation lowers the balance.
   * Same-date events are treated as NOT "after" (the ordering between a
   * revaluation and a same-day move is ambiguous), so the boundary is exclusive.
   */
  private async sumEventContributionsAfter(
    householdId: string,
    assetId: string,
    excludeEventId: string,
    afterDate: string,
  ): Promise<number> {
    const events = await this.assetsRepository.findMoneyEventsByAsset(
      householdId,
      assetId,
    );
    let sum = 0;
    for (const event of events) {
      if (event.id === excludeEventId || event.isoDate <= afterDate) {
        continue;
      }
      if (event.type === 'asset_update') {
        // Signed delta already; only counts when this asset is the target.
        if (event.toAssetId === assetId) {
          sum += event.amount;
        }
        continue;
      }
      const net = event.amount - (event.feeAmount ?? 0);
      if (event.toAssetId === assetId) {
        sum += net;
      } else if (event.fromAssetId === assetId) {
        sum -= net;
      }
    }
    return sum;
  }

  /**
   * Append/update the history point linked to a money event (keyed on
   * `moneyEventId + assetId`, dated at the event's date) with an **explicit**
   * value, rather than the asset's recomputed "now" value. Used when the point
   * must record the value the asset held *at the event's date* (a back-dated
   * revaluation whose later events already moved the balance past it). Runs inside
   * the caller's transaction.
   */
  private async writeLinkedValuationPoint(
    asset: Asset,
    value: number,
    context: ValuationContext,
  ): Promise<void> {
    if (!context.moneyEventId) {
      return;
    }
    await this.assetsRepository.insertAssetValueHistory({
      id: this.assetsRepository.createId('valuation'),
      assetId: asset.id,
      householdId: asset.householdId,
      valuationDate: context.valuationDate ?? AS_OF,
      value,
      currency: asset.currency,
      note: asset.note,
      moneyEventId: context.moneyEventId,
      ...this.valuationLineage(asset),
    });
  }

  async deleteAsset(householdId: string, assetId: string) {
    await this.ensureAsset(householdId, assetId);
    // These three writes must all land or none: run them in one transaction,
    // sequentially (they share the transaction's single connection).
    await this.prisma.runInTransaction(async () => {
      await this.assetsRepository.deleteAsset(assetId);
      await this.assetsRepository.deleteAssetValueHistory(assetId);
      await this.assetsRepository.unlinkAssetFromMoneyEvents(assetId);
    });
    await this.snapshots.onAssetRemoved(householdId, assetId);
    return {
      deleted: true,
      assetId,
    };
  }

  /**
   * Add `amount` to a manual asset's stored value and refresh its valuation.
   * Used when money lands in a wallet from outside the events ledger — e.g.
   * borrowing a debt credits the "received to" wallet (see [[debts]] /
   * [[domain-overview]]: the asset and the debt rise together, net worth
   * unchanged); an income / transfer-in money event credits its `toAsset`.
   * Only wallet assets (`cash` / `bank_account`) hold a free cash balance, so
   * crediting any other asset type is a no-op.
   *
   * Meant to run inside an existing `runInTransaction`, so it does not open its
   * own transaction — the caller owns atomicity.
   */
  async creditManualAsset(
    householdId: string,
    assetId: string,
    amount: number,
    context?: ValuationContext,
  ): Promise<void> {
    if (!(amount > 0)) {
      return;
    }
    const asset = await this.ensureAsset(householdId, assetId);
    if (!WALLET_ASSET_TYPES.has(asset.type)) {
      return;
    }
    const next: Asset = {
      ...asset,
      manualValue: (asset.manualValue ?? 0) + amount,
    };
    await this.assetsRepository.updateAsset(assetId, next);
    await this.upsertCurrentValuation(next, context);
  }

  /**
   * Reverse of {@link creditManualAsset}: subtract `amount` from a wallet
   * asset's stored value and refresh its valuation. Used when money leaves a
   * wallet — e.g. an expense / transfer-out money event debits its `fromAsset`,
   * or deleting a debt reverses the credit its borrow put into the "received to"
   * wallet. Floors at 0 so a debit can never drive a wallet negative. No-op for
   * non-wallet asset types, mirroring the credit side.
   *
   * Meant to run inside an existing `runInTransaction`.
   */
  async debitManualAsset(
    householdId: string,
    assetId: string,
    amount: number,
    context?: ValuationContext,
  ): Promise<void> {
    if (!(amount > 0)) {
      return;
    }
    const asset = await this.ensureAsset(householdId, assetId);
    if (!WALLET_ASSET_TYPES.has(asset.type)) {
      return;
    }
    const next: Asset = {
      ...asset,
      manualValue: Math.max(0, (asset.manualValue ?? 0) - amount),
    };
    await this.assetsRepository.updateAsset(assetId, next);
    await this.upsertCurrentValuation(next, context);
  }

  /**
   * Asset types that can be sold through the asset-sale flow. Market-priced
   * ones carry an `asset_market_positions` row (partial sale = reduce
   * `quantity`); `real_estate` / `investment` are manual (partial sale = reduce
   * the stored value). Wallets, deposits, insurance and `other` are excluded —
   * see [[asset-sale]] for the rationale. Exported-shape check used by the
   * money-events service to validate an `asset_sale` before applying it.
   */
  static readonly SELLABLE_ASSET_TYPES: ReadonlySet<AssetType> =
    new Set<AssetType>([
      'gold',
      'stock',
      'crypto',
      'fund',
      'foreign_currency',
      'bond',
      'real_estate',
      'investment',
    ]);

  /**
   * Apply a sale to the sold asset: reduce its position and, when nothing is
   * left, mark it `sold`. Runs inside the money-event transaction (shared
   * connection) so it commits or rolls back with the event write.
   *
   * - Market assets (a live `marketPosition`): decrement `quantity` by
   *   `quantitySold` (floored at 0). `sellAll` forces the quantity to 0.
   * - Manual assets (`real_estate` / `investment`): reduce `manualValue` by
   *   `valueSold` (floored at 0). `sellAll` forces it to 0.
   *
   * When the remaining position/value reaches 0 (or `sellAll`), the asset is
   * closed out: `status = 'sold'`, `soldAt = soldOn`. A partial sale leaves the
   * asset `active`. Returns the post-sale asset so the caller/tests can inspect
   * it; the valuation row is refreshed here too.
   */
  async sellPosition(
    householdId: string,
    assetId: string,
    sale: {
      quantitySold?: number;
      valueSold?: number;
      sellAll?: boolean;
      soldOn: string;
    },
    context?: ValuationContext,
  ): Promise<Asset> {
    const asset = await this.ensureAsset(householdId, assetId);
    if (!AssetsService.SELLABLE_ASSET_TYPES.has(asset.type)) {
      throw new BadRequestException(
        `Asset type "${asset.type}" cannot be sold`,
      );
    }

    const next: Asset = { ...asset };
    let fullySold = sale.sellAll === true;

    if (asset.marketPosition) {
      const current = asset.marketPosition.quantity;
      const sold = sale.sellAll ? current : (sale.quantitySold ?? 0);
      if (sold > current) {
        throw new BadRequestException(
          'Quantity sold exceeds the current position',
        );
      }
      const remaining = sale.sellAll ? 0 : Math.max(0, current - sold);
      next.marketPosition = { ...asset.marketPosition, quantity: remaining };
      if (remaining <= 0) {
        fullySold = true;
      }
    } else if (asset.type === 'real_estate' && asset.areaSqm !== undefined) {
      const currentArea = asset.areaSqm;
      const soldArea = sale.sellAll ? currentArea : (sale.quantitySold ?? 0);
      if (soldArea > currentArea) {
        throw new BadRequestException(
          'Area sold exceeds the current property area',
        );
      }
      next.areaSqm = sale.sellAll ? 0 : Math.max(0, currentArea - soldArea);
      const currentValue = asset.manualValue ?? 0;
      next.manualValue = sale.sellAll
        ? 0
        : Math.max(0, currentValue - (sale.valueSold ?? 0));
      if (next.areaSqm <= 0) fullySold = true;
    } else if (asset.type === 'bond' && asset.calculationTerm) {
      const current = asset.calculationTerm.principalAmount;
      const sold = sale.sellAll ? current : (sale.valueSold ?? 0);
      const remaining = sale.sellAll ? 0 : Math.max(0, current - sold);
      next.calculationTerm = {
        ...asset.calculationTerm,
        principalAmount: remaining,
      };
      if (remaining <= 0) fullySold = true;
    } else {
      // Manual asset: reduce the stored value by the sold portion.
      const current = asset.manualValue ?? 0;
      const sold = sale.sellAll ? current : (sale.valueSold ?? 0);
      const remaining = sale.sellAll ? 0 : Math.max(0, current - sold);
      next.manualValue = remaining;
      if (remaining <= 0) {
        fullySold = true;
      }
    }

    if (fullySold) {
      next.status = 'sold';
      next.soldAt = sale.soldOn;
      if (next.marketPosition) {
        next.marketPosition = { ...next.marketPosition, quantity: 0 };
      } else if (next.type === 'bond' && next.calculationTerm) {
        next.calculationTerm = { ...next.calculationTerm, principalAmount: 0 };
      } else {
        next.manualValue = 0;
        if (next.type === 'real_estate') next.areaSqm = 0;
      }
    }

    await this.assetsRepository.updateAsset(assetId, next);
    await this.upsertCurrentValuation(next, context);
    return next;
  }

  /**
   * Reverse a previously-applied sale on an asset: add the position/value back
   * and reopen it if the sale had marked it `sold`. Used when an `asset_sale`
   * money event is edited or deleted. Runs inside the caller's transaction.
   */
  async reverseSalePosition(
    householdId: string,
    assetId: string,
    sale: { quantitySold?: number; valueSold?: number },
    context?: ValuationContext,
  ): Promise<void> {
    const asset = await this.ensureAsset(householdId, assetId);
    const next: Asset = { ...asset };

    // The money event persists the resolved sold quantity/value (even for a
    // "sell all"), so reversal adds exactly that back — no need to re-derive it.
    if (asset.marketPosition) {
      next.marketPosition = {
        ...asset.marketPosition,
        quantity: asset.marketPosition.quantity + (sale.quantitySold ?? 0),
      };
    } else if (asset.type === 'real_estate' && asset.areaSqm !== undefined) {
      next.areaSqm = asset.areaSqm + (sale.quantitySold ?? 0);
      next.manualValue = (asset.manualValue ?? 0) + (sale.valueSold ?? 0);
    } else if (asset.type === 'bond' && asset.calculationTerm) {
      next.calculationTerm = {
        ...asset.calculationTerm,
        principalAmount:
          asset.calculationTerm.principalAmount + (sale.valueSold ?? 0),
      };
    } else {
      next.manualValue = (asset.manualValue ?? 0) + (sale.valueSold ?? 0);
    }

    // Reopen an asset that the sale had closed.
    if (asset.status === 'sold') {
      next.status = 'active';
      next.soldAt = undefined;
    }

    await this.assetsRepository.updateAsset(assetId, next);
    await this.upsertCurrentValuation(next, context);
  }

  /** Fetch the raw asset entity (with its calculation term). Used by accrual. */
  async getAssetEntity(householdId: string, assetId: string): Promise<Asset> {
    return this.ensureAsset(householdId, assetId);
  }

  /** Whether an asset type holds a free, spendable cash balance (cash / bank). */
  static isWalletAssetType(type: AssetType): boolean {
    return WALLET_ASSET_TYPES.has(type);
  }

  /**
   * Assert that an asset is a spendable wallet (cash / bank_account) — the only
   * asset kinds that can be the source or destination of a plain income /
   * expense / transfer money event. A valued asset (gold, stock, saving deposit,
   * …) changes hands through its own dedicated flow (sell / revalue), never a
   * generic cash move, so linking one here is a user error → 400. See
   * [[money-events]].
   */
  async assertWalletAsset(householdId: string, assetId: string): Promise<void> {
    const asset = await this.ensureAsset(householdId, assetId);
    if (!WALLET_ASSET_TYPES.has(asset.type)) {
      throw new BadRequestException(
        `Asset "${asset.name}" is not a cash or bank account, so it cannot be the source or destination of an income, expense, or transfer.`,
      );
    }
  }

  /**
   * Write an `AssetValueHistory` point for a saving deposit dated at an interest
   * payout, for the auto-crediting flow — one per credited period. Idempotent
   * per date: an existing row at `valuationDate` is updated in place. Runs inside
   * the caller's transaction.
   */
  async writeSavingValuationAt(
    asset: Asset,
    valuationDate: string,
    value: number,
  ): Promise<void> {
    const existing = await this.assetsRepository.findAssetValueHistory(
      asset.id,
      valuationDate,
    );
    if (existing) {
      existing.value = value;
      existing.currency = asset.currency;
      existing.method = 'formula_calculated';
      existing.note = asset.note;
      await this.assetsRepository.insertAssetValueHistory(existing);
      return;
    }
    await this.assetsRepository.insertAssetValueHistory({
      id: this.assetsRepository.createId('valuation'),
      assetId: asset.id,
      householdId: asset.householdId,
      valuationDate,
      value,
      currency: asset.currency,
      method: 'formula_calculated',
      note: asset.note,
    });
  }

  /**
   * Capitalize an interest payout into a saving deposit's principal (destination
   * `principal` — "nhập lãi vào vốn gốc"), so the interest compounds. Bumps the
   * stored `principalAmount` and refreshes the deposit's current valuation.
   * Runs inside the caller's transaction.
   */
  async capitalizeSavingInterest(
    householdId: string,
    assetId: string,
    amount: number,
  ): Promise<void> {
    if (!(amount > 0)) {
      return;
    }
    const asset = await this.ensureAsset(householdId, assetId);
    if (!asset.calculationTerm) {
      return;
    }
    const next: Asset = {
      ...asset,
      calculationTerm: {
        ...asset.calculationTerm,
        principalAmount: asset.calculationTerm.principalAmount + amount,
      },
    };
    await this.assetsRepository.updateAsset(assetId, next);
    await this.upsertCurrentValuation(next);
  }

  private async getAssetRecords(householdId: string) {
    const [assets, marketPrices, fxRates] = await Promise.all([
      this.assetsRepository.findAssetsByHousehold(householdId),
      this.marketData.getMarketPrices(),
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
        valueUpdatedAt: AS_OF,
      };
    });
  }

  /**
   * Active assets with their computed current value — the exact input a
   * snapshot freezes. Exposed for `SnapshotsService` (reuses the same valuation
   * engine so the snapshot totals can never diverge from the live figures). A
   * sold/closed asset no longer contributes to net worth (see [[asset-sale]]).
   */
  async getActiveAssetRecords(householdId: string) {
    const records = await this.getAssetRecords(householdId);
    return records.filter((asset) => asset.status === 'active');
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
      valueUpdatedAt: AS_OF,
    };
  }

  /**
   * Recompute an asset's value and persist it.
   *
   * When a {@link ValuationContext} is supplied — i.e. the change was driven by a
   * money event (a wallet credit/debit, a sale, a direct revaluation) — it
   * appends/updates a single history point in `asset_value_history` linked to
   * that event: a record keyed on `(moneyEventId, assetId)`, dated at the event's
   * date. That linked record is what value-history reads and what an event
   * edit/delete later updates or soft-deletes. Two same-day events on one asset
   * keep two distinct points; re-running the same event updates its own point in
   * place. No context (e.g. capitalizing saving interest, whose dated point is
   * written separately by `writeSavingValuationAt`) → no history row, only the
   * cache refresh below.
   *
   * The single source of an asset's "value now" is the `assets.current_value`
   * column, refreshed here for EVERY mode — there is deliberately no separate
   * unlinked cache row in `asset_value_history` (it only holds real history
   * points).
   */
  private async upsertCurrentValuation(
    asset: Asset,
    context?: ValuationContext,
  ): Promise<number> {
    // Called inside the asset create/update transaction (shared connection), so
    // these reads run sequentially rather than concurrently on the same client.
    const marketPrices = await this.marketData.getMarketPrices();
    const fxRates = await this.assetsRepository.getFxRates();
    const value = computeCurrentValue(asset, marketPrices, fxRates, AS_OF);

    // When the change came from a money event, append/update the history point
    // linked to that event (keyed on moneyEventId + assetId).
    if (context?.moneyEventId) {
      await this.assetsRepository.insertAssetValueHistory({
        id: this.assetsRepository.createId('valuation'),
        assetId: asset.id,
        householdId: asset.householdId,
        valuationDate: context.valuationDate ?? AS_OF,
        value,
        currency: asset.currency,
        note: asset.note,
        moneyEventId: context.moneyEventId,
        ...this.valuationLineage(asset),
      });
    }

    // Keep the `assets.current_value` cache in sync for EVERY mode (the plain
    // create/update path only wrote `manualValue`, leaving derived assets stale).
    await this.assetsRepository.updateAssetCurrentValue(asset.id, value);

    return value;
  }

  /**
   * Write the asset's starting value on create: one unlinked history point dated
   * AS_OF plus the `current_value` cache. Unlike a re-pricing, creating an asset
   * logs NO money event (it moves no money), so this point carries no
   * `moneyEventId`. Runs inside the create transaction (shared connection).
   */
  private async writeInitialValuation(asset: Asset): Promise<number> {
    const marketPrices = await this.marketData.getMarketPrices();
    const fxRates = await this.assetsRepository.getFxRates();
    const value = computeCurrentValue(asset, marketPrices, fxRates, AS_OF);

    await this.assetsRepository.insertAssetValueHistory({
      id: this.assetsRepository.createId('valuation'),
      assetId: asset.id,
      householdId: asset.householdId,
      valuationDate: AS_OF,
      value,
      currency: asset.currency,
      note: asset.note,
      ...this.valuationLineage(asset),
    });
    await this.assetsRepository.updateAssetCurrentValue(asset.id, value);
    return value;
  }

  /**
   * Lineage for a valuation point derived from the asset's mode: where the
   * number came from + how much we trust it. `manual` = user-entered (high
   * confidence, no external source); `formula` ties back to the calculation
   * term. Market position details stay in `asset_market_positions`; history
   * stores only the resulting value and its high-level lineage.
   */
  private valuationLineage(asset: Asset): {
    method: AssetValueHistory['method'];
    source: string;
    confidenceLevel: AssetValueHistory['confidenceLevel'];
  } {
    const method: AssetValueHistory['method'] =
      asset.valuationMode === 'manual'
        ? 'manual'
        : asset.valuationMode === 'market_priced'
          ? 'market_price_api'
          : 'formula_calculated';
    const source =
      asset.valuationMode === 'manual'
        ? 'user'
        : asset.valuationMode === 'market_priced'
          ? 'market_price_api'
          : 'formula';
    const confidenceLevel: AssetValueHistory['confidenceLevel'] =
      asset.valuationMode === 'manual' ? 'high' : 'medium';
    return { method, source, confidenceLevel };
  }
}
