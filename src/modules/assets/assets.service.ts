import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { todayInTimeZone } from '../../common/utils/clock';
import { freshnessOf, staleAfterDaysFor } from '../../common/utils/freshness';
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

/**
 * A whole đồng amount, grouped the Vietnamese way, for user-facing messages
 * ("12.000.000 đ"). Server-side errors are read by a person, so the figure they
 * name has to look like the one on their screen.
 */
function formatVndPlain(amount: number): string {
  return `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(Math.round(amount))} đ`;
}
import { AssetValueHistory } from './entities/asset-value-history.entity';
import type { MoneyEvent } from '../money-events/entities/money-event.entity';
import {
  computeCurrentValue,
  computeLiquidityTotals,
  defaultValuationModeForAssetType,
  liquidityForAsset,
  marketUnitForAssetType,
  normalizeCountsAsFlexible,
} from '../../common/utils/money-space.utils';
import type { CreateAssetDto } from './dto/create-asset.dto';
import type { UpdateAssetDto } from './dto/update-asset.dto';
import type { PurchaseIntoPositionDto } from './dto/purchase-into-position.dto';
import { ASSETS_REPOSITORY } from './repositories/assets.repository.interface';
import type { AssetsRepository } from './repositories/assets.repository.interface';
import { MarketDataService } from '../market-data/market-data.service';
// Repositories, not services: Goals/CashflowEvents/Debts all import Assets, so
// depending on their SERVICES here would close a cycle. Only plain reads and
// the unlink writes are needed, which is exactly what GoalsModule already does
// with SNAPSHOTS_REPOSITORY and CASHFLOW_EVENTS_REPOSITORY for the same reason.
import { GOALS_REPOSITORY } from '../goals/repositories/goals.repository.interface';
import type { GoalsRepository } from '../goals/repositories/goals.repository.interface';
import { CASHFLOW_EVENTS_REPOSITORY } from '../cashflow-events/repositories/cashflow-events.repository.interface';
import type { CashflowEventsRepository } from '../cashflow-events/repositories/cashflow-events.repository.interface';
import { DEBTS_REPOSITORY } from '../debts/repositories/debts.repository.interface';
import type { DebtsRepository } from '../debts/repositories/debts.repository.interface';
import {
  resolvePlannedMonthlyContribution,
  toAllocationInput,
} from '../goals/domain/goal-progress';

/**
 * Ties a valuation write back to the money event that caused it, so the value
 * point lands in history linked to that event (and dated at the event's date).
 * Absent for changes with no event origin (a plain asset create/update writes
 * only today's cache row).
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
    private readonly marketData: MarketDataService,
    private readonly audit: AuditService,
    @Inject(GOALS_REPOSITORY)
    private readonly goalsRepository: GoalsRepository,
    @Inject(CASHFLOW_EVENTS_REPOSITORY)
    private readonly cashflowEventsRepository: CashflowEventsRepository,
    @Inject(DEBTS_REPOSITORY)
    private readonly debtsRepository: DebtsRepository,
  ) {}

  private readonly logger = new Logger(AssetsService.name);

  async listAssets(householdId: string) {
    // `assertHousehold` only guards; it does not feed `getAssetRecords`. Running
    // it serially made every request pay an extra Singapore round-trip before
    // the real work could even start. It still throws if the household is gone —
    // `Promise.all` rejects on the first failure — so the guarantee is unchanged.
    const [household, items] = await Promise.all([
      this.assetsRepository.assertHousehold(householdId),
      this.getAssetRecords(householdId),
    ]);

    return {
      household,
      asOf: todayInTimeZone(),
      items,
      total: items.length,
    };
  }

  async getAssetSummary(householdId: string) {
    // No `assertHousehold`: unlike `listAssets` the summary does not return the
    // household, and `HouseholdAccessGuard` already validated it for this route.
    const assets = await this.getAssetRecords(householdId);
    // A sold/closed asset no longer contributes to net worth or the liquidity
    // buckets — it is kept only for history. See [[asset-sale]].
    const activeAssets = assets.filter((asset) => asset.status === 'active');
    const totals = computeLiquidityTotals(activeAssets);

    return {
      householdId,
      asOf: todayInTimeZone(),
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
  /**
   * Re-price every market asset and record the day's point.
   *
   * `valuationDate` defaults to today. `AssetsValuationCron` passes the **day it
   * is capturing** — it runs at the end of that day, so the prices it reads are
   * that day's closing figures and must be stamped with that day's date, not
   * with whatever day a long batch happens to finish on.
   *
   * This is the ONLY writer of the daily series. Nothing re-prices mid-session
   * any more: `assets.current_value` is recomputed live on every read, so an
   * intraday write bought nothing and would have put an unsettled figure next
   * to end-of-day points.
   */
  async refreshMarketValuations(householdId: string, valuationDate?: string) {
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
    // Values are pure arithmetic over data already in memory, so compute the
    // whole batch first and write it in two statements.
    //
    // The per-asset path costs three round-trips each (lookup + write + current
    // value). At ~53ms RTT that is ~1.6s for ten positions, and a household with
    // ~30 would exceed the interactive-transaction timeout and roll the whole
    // day back — losing the data point entirely. Run across every household by
    // the daily job it would also monopolise the small connection pool and
    // starve real requests. Two bulk statements make the cost per household flat.
    const asOf = valuationDate ?? todayInTimeZone();
    const pointDate = valuationDate ?? this.todayIso();
    const priced = marketAssets.map((asset) => ({
      asset,
      value: computeCurrentValue(asset, marketPrices, fxRates, asOf),
    }));

    await this.prisma.runInTransaction(async () => {
      await this.assetsRepository.upsertMarketValuationPoints(
        priced.map(({ asset, value }) => ({
          id: this.assetsRepository.createId('valuation'),
          assetId: asset.id,
          householdId,
          valuationDate: pointDate,
          value,
          currency: asset.currency,
          note: `Định giá định kỳ: ${asset.name}`,
          ...this.valuationLineage(asset),
        })),
      );
      await this.assetsRepository.updateAssetCurrentValues(
        priced.map(({ asset, value }) => ({ assetId: asset.id, value })),
      );
    });
    return {
      householdId,
      refreshed: marketAssets.length,
      asOf: pointDate,
    };
  }

  async getAssetSnapshots(householdId: string) {
    const [, items] = await Promise.all([
      this.assetsRepository.assertHousehold(householdId),
      this.assetsRepository.getSnapshotsByHousehold(householdId),
    ]);

    return {
      householdId,
      items,
      total: items.length,
    };
  }

  /**
   * How old the household's picture is (spec 04 §12, §22).
   *
   * A v3.1 forecast is only as trustworthy as the balances it starts from, so
   * the product says how stale those balances are — **without implying the
   * household did anything wrong**. Every field here is a code or a number; the
   * client writes the sentence.
   *
   * The cadence is the household's OWN `updateFrequency`. A household on
   * `manual` never goes stale: they explicitly said "we'll update when we want
   * to", and grading them against a schedule they never agreed to is exactly
   * the nagging §29 rules out.
   */
  async getDataFreshness(householdId: string) {
    const household = await this.assetsRepository.assertHousehold(householdId);
    const asOfDate = todayInTimeZone();
    const assets = (await this.getAssetRecords(householdId)).filter(
      (asset) => asset.status === 'active',
    );

    const items = assets.map((asset) => {
      const freshness = freshnessOf(
        asOfDate,
        asset.valueUpdatedAt,
        household.updateFrequency,
      );
      return {
        assetId: asset.id,
        name: asset.name,
        liquidity: asset.liquidity,
        currentValue: asset.currentValue,
        valueUpdatedAt: asset.valueUpdatedAt ?? null,
        ...freshness,
      };
    });

    const counts = { fresh: 0, aging: 0, stale: 0, unknown: 0 };
    for (const item of items) {
      counts[item.state] += 1;
    }

    // The oldest value is what actually bounds how much the whole picture can
    // be trusted — one stale bank balance undermines the forecast regardless of
    // how fresh everything else is.
    const dated = items.filter((item) => item.daysSinceUpdate !== null);
    const oldestDays = dated.length
      ? Math.max(...dated.map((item) => item.daysSinceUpdate as number))
      : null;

    return {
      householdId,
      asOfDate,
      updateFrequency: household.updateFrequency,
      staleAfterDays: staleAfterDaysFor(household.updateFrequency),
      counts,
      oldestDaysSinceUpdate: oldestDays,
      // A single flag the Home screen can act on without re-deriving the rule.
      needsAttention: counts.stale > 0,
      items,
      total: items.length,
    };
  }

  /**
   * "I checked — nothing changed."
   *
   * Records freshness WITHOUT writing a value, and deliberately creates no
   * valuation history point: nothing about the money changed, so inventing a
   * history entry would put a fictional data point on the asset's chart.
   *
   * With no `assetIds`, confirms every active asset — the one-tap case from the
   * freshness sheet, which is the whole reason this exists rather than making
   * the user re-enter numbers they know are still right.
   */
  async confirmAssetsUnchanged(
    householdId: string,
    payload: { assetIds?: string[] } = {},
  ) {
    await this.assetsRepository.assertHousehold(householdId);
    const assetIds = (payload.assetIds ?? []).filter(Boolean);
    const confirmed = await this.assetsRepository.confirmAssetsUnchanged(
      householdId,
      assetIds,
    );

    return {
      householdId,
      confirmed,
      confirmedAt: new Date().toISOString(),
      scope: assetIds.length > 0 ? ('selected' as const) : ('all' as const),
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
      { date: todayInTimeZone(), value: currentValue },
    ];

    let quantity = currentQuantity;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      // Unwind the holding backwards. A sale reduced it by `soldQuantity`, so
      // the position before the sale was that much larger.
      if (event.type === 'asset_sale' && event.fromAssetId === asset.id) {
        quantity += event.soldQuantity ?? 0;
        points.push({
          date: event.isoDate,
          value: Math.max(0, quantity * currentUnitPrice),
        });
        continue;
      }
      // A quantity adjustment states both sides, so unwinding is exact: before
      // it, the holding was whatever it says it was. This is the case the old
      // "only sales change the quantity" assumption got wrong — without it, every
      // point before a correction was priced at the corrected holding and the
      // whole earlier curve was off by the correction's factor.
      if (
        event.type === 'asset_quantity_adjustment' &&
        event.toAssetId === asset.id &&
        event.quantityBefore !== undefined
      ) {
        quantity = event.quantityBefore;
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
      { date: todayInTimeZone(), value: currentValue },
    ];
    let running = currentValue;
    for (let i = changes.length - 1; i >= 0; i -= 1) {
      running -= changes[i].amount;
      points.push({ date: changes[i].isoDate, value: Math.max(0, running) });
    }
    points.reverse();
    return points;
  }

  async createAsset(
    householdId: string,
    payload: CreateAssetDto,
    creatorMemberId?: string,
  ) {
    // `insertAsset` asserts the household exists (and needs its row to resolve
    // `createdById`), so we don't assert it a second time here.
    const asset = this.normalizeAsset({
      id: this.assetsRepository.createId('asset'),
      householdId,
      name: payload.name,
      type: payload.type,
      valuationMode:
        payload.valuationMode ?? defaultValuationModeForAssetType(payload.type),
      countsAsFlexible: normalizeCountsAsFlexible(
        payload.type,
        payload.countsAsFlexible,
      ),
      liquidity: liquidityForAsset(payload.type, payload.countsAsFlexible),
      currency: payload.currency ?? 'VND',
      note: payload.note ?? '',
      status: 'active',
      areaSqm: payload.areaSqm,
      manualValue: payload.manualValue,
      marketPosition: payload.marketPosition,
      calculationTerm: payload.calculationTerm,
      holderMemberId: payload.holderMemberId || creatorMemberId || null,
    });

    // "We just bought this" names the wallet that paid; "we already own this"
    // leaves it out. Only the former moves money, and only it has to be
    // affordable — checked here, before the write transaction opens, so a
    // rejected purchase leaves nothing behind.
    const fundingAssetId = payload.fundingAssetId || null;
    if (fundingAssetId) {
      await this.assertFundingWalletCovers(
        householdId,
        fundingAssetId,
        await this.resolvePurchaseCost(asset),
      );
    }

    // The asset row and its initial valuation must be written atomically. When
    // the household already has an active position for the same class+symbol,
    // add to that position and recompute weighted-average purchase price rather
    // than creating a duplicate asset row.
    //
    // Whether a money event is logged depends on the ACT, not on which branch
    // runs: a purchase (funding wallet named) always logs an `asset_purchase`
    // and debits that wallet, so net worth stays put; declaring something
    // already owned logs nothing — an opening position moves no money, and its
    // value is new information rather than new wealth.
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
          const context = await this.logAdditionalPurchase(
            merged,
            incoming,
            fundingAssetId,
          );
          const value = await this.upsertCurrentValuation(merged, context);
          return { asset: merged, currentValue: value };
        }
      }
      await this.assetsRepository.insertAsset(asset);
      const currentValue = await this.writeInitialValuation(asset);
      if (fundingAssetId) {
        await this.logInitialPurchase(
          asset,
          await this.resolvePurchaseCost(asset, currentValue),
          fundingAssetId,
        );
      }
      return { asset, currentValue };
    });
    return this.toAssetRecord(result.asset, result.currentValue);
  }

  /**
   * What the household actually paid, for a create that is a purchase.
   *
   * For a market position that is `quantity × purchase price` — the cost basis,
   * NOT today's market value. Buying 1 lượng at 80tr when the live price says
   * 82tr must take 80tr out of the wallet; charging the market price would
   * invent a 2tr loss the household never incurred.
   *
   * Everything else has no separate cost basis, so the asset's own value is the
   * price paid. `knownValue` lets a caller that already computed it (inside the
   * write transaction) skip a second round-trip to the market/FX data.
   */
  private async resolvePurchaseCost(
    asset: Asset,
    knownValue?: number,
  ): Promise<number> {
    const position = asset.marketPosition;
    if (position?.purchasePrice) {
      return Math.max(0, position.quantity * position.purchasePrice);
    }
    if (knownValue !== undefined) {
      return Math.max(0, knownValue);
    }
    const [marketPrices, fxRates] = await Promise.all([
      this.marketData.getMarketPrices(),
      this.assetsRepository.getFxRates(),
    ]);
    return Math.max(
      0,
      computeCurrentValue(asset, marketPrices, fxRates, todayInTimeZone()),
    );
  }

  async updateAsset(
    householdId: string,
    assetId: string,
    payload: UpdateAssetDto,
  ) {
    const current = await this.ensureAsset(householdId, assetId);
    const nextType = payload.type ?? current.type;
    // An untouched override survives a type change as INTENT, but is dropped
    // once it merely restates the new type's own default.
    const nextCountsAsFlexible = normalizeCountsAsFlexible(
      nextType,
      payload.countsAsFlexible !== undefined
        ? payload.countsAsFlexible
        : current.countsAsFlexible,
    );
    const next = this.normalizeAsset({
      ...current,
      id: current.id,
      householdId: current.householdId,
      valuationMode:
        payload.valuationMode ??
        defaultValuationModeForAssetType(payload.type ?? current.type),
      name: payload.name ?? current.name,
      type: nextType,
      countsAsFlexible: nextCountsAsFlexible,
      liquidity: liquidityForAsset(nextType, nextCountsAsFlexible),
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
      holderMemberId:
        payload.holderMemberId !== undefined
          ? payload.holderMemberId
          : current.holderMemberId,
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
      // A corrected holding is checked first and gets its OWN event type. It
      // used to fall through to `logRevaluation` and be recorded as a price
      // movement, which is how a re-count showed up as a market loss.
      const quantityOnly = this.isQuantityOnlyUpdate(current, next);
      if (quantityOnly) {
        const context = await this.logQuantityAdjustment(
          next,
          current.marketPosition?.quantity ?? 0,
          next.marketPosition?.quantity ?? 0,
          oldValue,
          value,
        );
        return this.upsertCurrentValuation(next, context);
      }
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
    return this.toAssetRecord(next, currentValue);
  }

  /**
   * Buy more of a position the household already holds.
   *
   * The counterpart to `sellPosition`. Until it existed the only way to add to a
   * holding was to type a bigger number into the edit form, which moved no money
   * and left no event — the quantity simply grew and net worth grew with it.
   *
   * Two things happen that a raw quantity edit cannot do:
   *  - the wallet that paid is debited, so net worth stays put (the purchase
   *    converts money into an asset rather than conjuring one); and
   *  - `purchasePrice` is re-averaged across old and new lots, so P&L keeps
   *    measuring against what was actually paid. Editing quantity alone priced
   *    the whole enlarged holding at the old basis and invented a gain.
   *
   * `fundingAssetId` is optional: quantity can arrive without being bought (a
   * gift, a stock dividend). Then no wallet moves and net worth does rise —
   * which is correct, because something arrived from outside the household.
   */
  async purchaseIntoPosition(
    householdId: string,
    assetId: string,
    payload: PurchaseIntoPositionDto,
  ) {
    const asset = await this.ensureAsset(householdId, assetId);
    const held = asset.marketPosition;
    if (!held) {
      throw new BadRequestException(
        'Chỉ tài sản theo giá thị trường mới có số lượng để mua thêm',
      );
    }
    if (!(payload.quantity > 0)) {
      throw new BadRequestException('Số lượng mua thêm phải lớn hơn 0');
    }
    if (payload.purchasePrice < 0) {
      throw new BadRequestException('Giá mua không hợp lệ');
    }

    const cost = payload.quantity * payload.purchasePrice;
    const fundingAssetId = payload.fundingAssetId || null;
    // Checked before the transaction opens, like `createAsset` does, so a
    // rejected purchase leaves nothing behind.
    if (fundingAssetId) {
      await this.assertFundingWalletCovers(householdId, fundingAssetId, cost);
    }

    // Weighted average across the lots — the same formula the same-symbol merge
    // in `createAsset` uses, kept identical so the two entry points cannot drift
    // into disagreeing about what a holding cost.
    const quantity = held.quantity + payload.quantity;
    const heldCost = held.purchasePrice ?? 0;
    const purchasePrice =
      quantity > 0
        ? (held.quantity * heldCost + payload.quantity * payload.purchasePrice) /
          quantity
        : heldCost;
    const next: Asset = {
      ...asset,
      marketPosition: { ...held, quantity, purchasePrice },
    };

    const currentValue = await this.prisma.runInTransaction(async () => {
      await this.assetsRepository.updateAsset(assetId, next);
      const context = await this.logAdditionalPurchase(
        next,
        {
          ...held,
          quantity: payload.quantity,
          purchasePrice: payload.purchasePrice,
        },
        fundingAssetId,
      );
      return this.upsertCurrentValuation(next, context);
    });
    return this.toAssetRecord(next, currentValue);
  }

  /**
   * Compute an asset's current value the same way `upsertCurrentValuation` does,
   * so revaluation-delta detection and the persisted point can never diverge.
   */
  private async computeValueAsync(asset: Asset): Promise<number> {
    const marketPrices = await this.marketData.getMarketPrices();
    const fxRates = await this.assetsRepository.getFxRates();
    return computeCurrentValue(asset, marketPrices, fxRates, todayInTimeZone());
  }

  /** Today's date (YYYY-MM-DD), the date a user's direct re-pricing is stamped
   *  with — the UI has no date picker, so a revaluation is "as of now". Kept
   *  the same clock every valuation read uses. */
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
   * Log a quantity change that is neither a purchase nor a sale — a corrected
   * holding, a recount — as a neutral `asset_quantity_adjustment`.
   *
   * The sibling of {@link logRevaluation}, and deliberately not the same thing.
   * A revaluation says the price moved; this says the holding did. Routing a
   * quantity change through the revaluation path is what made correcting 10 chỉ
   * to 1 chỉ surface as a ~720tr market loss.
   *
   * Dated today: a re-count is knowledge gained now, not a retroactive claim
   * about the past, so the history it leaves is a new point rather than an edit
   * to old ones.
   */
  private async logQuantityAdjustment(
    asset: Asset,
    quantityBefore: number,
    quantityAfter: number,
    oldValue: number,
    newValue: number,
  ): Promise<ValuationContext> {
    const today = this.todayIso();
    const eventId = this.assetsRepository.createId('event');
    const format = (quantity: number) =>
      new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 8 }).format(
        quantity,
      );
    const unit = asset.marketPosition?.unit || 'đơn vị';
    const label = `Điều chỉnh số lượng: ${asset.name} (${format(quantityBefore)} → ${format(quantityAfter)} ${unit})`;
    const note = asset.note ? `${label} — ${asset.note}` : label;
    await this.assetsRepository.insertQuantityAdjustmentEvent({
      id: eventId,
      householdId: asset.householdId,
      assetId: asset.id,
      amount: newValue - oldValue,
      quantityBefore,
      quantityAfter,
      isoDate: today,
      note,
    });
    return { moneyEventId: eventId, valuationDate: today };
  }

  /**
   * Whether this update changes only the position's quantity — the holding was
   * corrected, nothing else moved.
   *
   * Checked BEFORE {@link isLatestMarketPriceOnlyUpdate} because the two are
   * mutually exclusive by construction (that one requires the quantity to be
   * unchanged) and because a quantity change must never reach `logRevaluation`.
   *
   * `purchasePrice` is deliberately part of "unchanged": cost basis is the anchor
   * P&L is measured against, and a household that edits both at once is doing
   * something this path cannot describe honestly — that still routes to the
   * revaluation branch, which at least records a value delta.
   */
  private isQuantityOnlyUpdate(current: Asset, next: Asset): boolean {
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
    const restUnchanged =
      before.assetClass === after.assetClass &&
      before.symbol === after.symbol &&
      before.unit === after.unit &&
      before.quoteCurrency === after.quoteCurrency &&
      before.purchasePrice === after.purchasePrice &&
      before.lastPrice === after.lastPrice;
    return restUnchanged && before.quantity !== after.quantity;
  }

  /**
   * Log quantity merged into an existing market position as an
   * `asset_purchase`, and — when the household named the wallet it paid from —
   * debit that wallet, so buying more of a position moves money instead of
   * conjuring it. The amount is the added position's cost basis and `toAssetId`
   * links the event to the resulting asset.
   */
  private async logAdditionalPurchase(
    asset: Asset,
    incoming: NonNullable<Asset['marketPosition']>,
    fundingAssetId?: string | null,
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
      fundingAssetId,
    });
    const context = { moneyEventId: eventId, valuationDate: today };
    if (fundingAssetId) {
      await this.debitManualAsset(
        asset.householdId,
        fundingAssetId,
        purchaseAmount,
        context,
      );
    }
    return context;
  }

  /**
   * Log the purchase of a brand-new asset and debit the wallet that paid for
   * it. Only called when the household said "we just bought this" — declaring
   * something already owned writes no event and touches no wallet (see
   * `CreateAssetDto.fundingAssetId`).
   *
   * The amount is the asset's freshly computed value, so the wallet loses
   * exactly what the asset is worth and **net worth does not move** — which is
   * the whole point of asking where the money came from.
   */
  private async logInitialPurchase(
    asset: Asset,
    value: number,
    fundingAssetId: string,
  ): Promise<void> {
    const today = this.todayIso();
    const eventId = this.assetsRepository.createId('event');
    await this.assetsRepository.insertAssetPurchaseEvent({
      id: eventId,
      householdId: asset.householdId,
      assetId: asset.id,
      amount: value,
      isoDate: today,
      note: `Mua ${asset.name}`,
      fundingAssetId,
    });
    await this.debitManualAsset(asset.householdId, fundingAssetId, value, {
      moneyEventId: eventId,
      valuationDate: today,
    });
  }

  /**
   * Guard the "we just bought this" path: the named source must be a real
   * wallet and must actually hold the money.
   *
   * Unlike an expense — which records something that already happened, possibly
   * against a stale balance — a purchase is being declared as it happens. If the
   * wallet cannot cover it, either its balance is out of date or the money came
   * from somewhere else; both need fixing BEFORE the write, not silently
   * absorbed by the `Math.max(0, …)` floor in `debitManualAsset`. Letting it
   * through would leave the wallet at 0 while the asset kept its full value —
   * inflating net worth, exactly the bug this flow exists to remove.
   *
   * Spending a wallet down to exactly 0 is fine; only overspending is rejected.
   * Runs BEFORE the write transaction opens.
   */
  private async assertFundingWalletCovers(
    householdId: string,
    fundingAssetId: string,
    amount: number,
  ): Promise<void> {
    await this.assertWalletAsset(householdId, fundingAssetId);
    const wallet = await this.ensureAsset(householdId, fundingAssetId);
    const balance = wallet.manualValue ?? 0;
    if (amount > balance) {
      throw new BadRequestException(
        `Ví "${wallet.name}" đang có ${formatVndPlain(balance)}, không đủ để mua ${formatVndPlain(amount)}. Kiểm tra lại số dư ví hoặc chọn ví khác.`,
      );
    }
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
      // A quantity adjustment is linked via `toAssetId` like a revaluation, but
      // its `amount` is the value delta the re-count implied — NOT cash that
      // arrived. Falling through to the generic branch below would credit the
      // asset with that delta twice: once here, and again from the position's
      // own recomputed `quantity × price`. Skip it outright.
      if (event.type === 'asset_quantity_adjustment') {
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
      valuationDate: context.valuationDate ?? todayInTimeZone(),
      value,
      currency: asset.currency,
      note: asset.note,
      moneyEventId: context.moneyEventId,
      ...this.valuationLineage(asset),
    });
  }

  /**
   * Everything that would be left pointing at nothing if this asset went away.
   *
   * Assets are SOFT-deleted, so the `onDelete: Cascade` declared on each of
   * these relations never fires — the rows simply outlive the asset. Read
   * before the delete so the household can be told what it is about to lose,
   * and read again inside the delete so the decision is made on current facts.
   */
  async getAssetDeleteImpact(householdId: string, assetId: string) {
    const asset = await this.ensureAsset(householdId, assetId);
    const [allocations, goals, cashflowEvents, debts] = await Promise.all([
      this.goalsRepository.findAllocationsByAsset(householdId, assetId),
      this.goalsRepository.findFinancialGoalsByHousehold(householdId),
      this.cashflowEventsRepository.findCashflowEventsByHousehold(householdId),
      this.debtsRepository.findDebtsByHousehold(householdId),
    ]);

    const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
    const allocationsByGoal = new Map<string, typeof allocations>();
    for (const allocation of allocations) {
      const list = allocationsByGoal.get(allocation.financialGoalId) ?? [];
      list.push(allocation);
      allocationsByGoal.set(allocation.financialGoalId, list);
    }

    // A goal whose LAST contribution wallet this is: after the delete it still
    // exists and still has a target, but nothing left to be saved into. It is
    // allowed (the household asked for that), and it is the one consequence
    // worth naming louder than the rest — hence its own list rather than a flag
    // buried in the goal rows.
    const goalsLosingLastWallet: Array<{ id: string; name: string }> = [];
    const affectedGoals: Array<{
      id: string;
      name: string;
      priority: string;
      allocationCount: number;
      losesLastWallet: boolean;
    }> = [];
    for (const [goalId, claimed] of allocationsByGoal) {
      const goal = goalsById.get(goalId);
      // A claim whose goal is already gone reports nothing: it went with the
      // goal, exactly as `assetGoalUsage` treats the same case.
      if (!goal) {
        continue;
      }
      const survivors = await this.goalsRepository.findAllocationsByGoal(
        householdId,
        goalId,
      );
      const remaining = survivors.filter(
        (allocation) => allocation.assetId !== assetId,
      );
      const losesLastWallet =
        claimed.some((allocation) => allocation.role === 'contribution') &&
        !remaining.some((allocation) => allocation.role === 'contribution');
      if (losesLastWallet) {
        goalsLosingLastWallet.push({ id: goal.id, name: goal.name });
      }
      affectedGoals.push({
        id: goal.id,
        name: goal.name,
        priority: goal.priority,
        allocationCount: claimed.length,
        losesLastWallet,
      });
    }

    const affectedCashflowEvents = cashflowEvents
      .filter(
        (event) =>
          event.plannedAssetId === assetId ||
          event.settlementAssetId === assetId ||
          event.lastCompletedAssetId === assetId,
      )
      .map((event) => ({
        id: event.id,
        name: event.name,
        expectedDate: event.expectedDate,
        status: event.status,
      }));

    const affectedDebts = debts
      .filter(
        (debt) =>
          debt.receivedToAssetId === assetId ||
          debt.repaymentAssetId === assetId,
      )
      .map((debt) => ({ id: debt.id, name: debt.name, status: debt.status }));

    return {
      householdId,
      assetId,
      assetName: asset.name,
      goals: affectedGoals,
      goalsLosingLastWallet,
      cashflowEvents: affectedCashflowEvents,
      debts: affectedDebts,
      /** Nothing points here; the delete needs no confirmation. */
      isClear:
        affectedGoals.length === 0 &&
        affectedCashflowEvents.length === 0 &&
        affectedDebts.length === 0,
    };
  }

  /**
   * Delete an asset, refusing by default while anything still points at it.
   *
   * The refusal is the point. Deleting an asset used to leave its goal claims,
   * its scheduled events and its debts behind, still naming a row nothing would
   * ever return again — a goal would go on showing a wallet the household had
   * removed, its progress quietly reading zero for that share. Nothing surfaced
   * it, because every one of those relations declares `onDelete: Cascade` and
   * cascade cannot fire against a soft delete.
   *
   * So the household is asked first. `cascade` is their answer, and it is only
   * ever given after `getAssetDeleteImpact` has told them what it costs — which
   * is also why cascade does not need to warn about anything itself.
   */
  async deleteAsset(
    householdId: string,
    assetId: string,
    actorId?: string,
    cascade = false,
  ) {
    const current = await this.ensureAsset(householdId, assetId);
    const impact = await this.getAssetDeleteImpact(householdId, assetId);

    if (!impact.isClear && !cascade) {
      throw new ConflictException({
        message:
          'This asset still backs goals, events or debts. Confirm to remove those links, or detach them first.',
        code: 'asset_in_use',
        impact,
      });
    }

    // These writes must all land or none: run them in one transaction,
    // sequentially (they share the transaction's single connection). The
    // journal entry joins the same transaction, so it can never describe a
    // deletion that was rolled back.
    await this.prisma.runInTransaction(async () => {
      await this.assetsRepository.deleteAsset(assetId);
      await this.assetsRepository.deleteAssetValueHistory(assetId);
      await this.assetsRepository.deleteAssetDetails(assetId);
      await this.assetsRepository.unlinkAssetFromMoneyEvents(assetId);
      await this.cashflowEventsRepository.unlinkAssetFromCashflowEvents(
        householdId,
        assetId,
      );
      await this.debtsRepository.unlinkAssetFromDebts(householdId, assetId);
      await this.goalsRepository.deleteAllocationsByAsset(householdId, assetId);

      // `financial_goals.planned_monthly_contribution` is a MIRROR of the
      // surviving claims, kept so the goals list and the forecast can show a
      // pace without reading allocations. Dropping this asset's claims without
      // rewriting it would leave every affected goal advertising a monthly pace
      // partly funded by a wallet that no longer exists — a number nobody could
      // trace back to anything. Recomputed from the claims that REMAIN, using
      // the same resolver every other allocation write ends in.
      for (const goal of impact.goals) {
        const remaining = await this.goalsRepository.findAllocationsByGoal(
          householdId,
          goal.id,
        );
        await this.goalsRepository.updatePlannedMonthlyContribution(
          householdId,
          goal.id,
          resolvePlannedMonthlyContribution(
            remaining.map((allocation) => toAllocationInput(allocation)),
          ),
        );
      }

      await this.audit.record(householdId, {
        actorId,
        action: 'asset.deleted',
        entityType: 'asset',
        entityId: assetId,
        impact: {
          metric: 'net_worth',
          delta: -(current.manualValue ?? 0),
        },
        details: {
          objectName: current.name,
          // What the delete took with it, so the journal can answer "why did
          // this goal's pace change?" without anyone re-deriving it.
          detachedGoals: impact.goals.map((goal) => goal.name),
          goalsLeftWithoutWallet: impact.goalsLosingLastWallet.map(
            (goal) => goal.name,
          ),
          detachedCashflowEventCount: impact.cashflowEvents.length,
          detachedDebtCount: impact.debts.length,
        },
      });
    });
    return {
      deleted: true,
      assetId,
      detached: {
        goals: impact.goals.length,
        goalsLeftWithoutWallet: impact.goalsLosingLastWallet.length,
        cashflowEvents: impact.cashflowEvents.length,
        debts: impact.debts.length,
      },
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
        todayInTimeZone(),
      );
      return {
        ...asset,
        currentValue,
        valueUpdatedAt: asset.valueUpdatedAt ?? null,
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
      if (next.marketPosition) {
        const symbol = next.marketPosition.symbol.trim().toUpperCase();
        next.name = symbol;
        next.marketPosition = {
          ...next.marketPosition,
          symbol,
          unit: marketUnitForAssetType(
            next.type,
            symbol,
            next.marketPosition.unit,
          ),
        };
      }
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
      valueUpdatedAt: asset.valueUpdatedAt ?? null,
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
    const value = computeCurrentValue(
      asset,
      marketPrices,
      fxRates,
      todayInTimeZone(),
    );

    // When the change came from a money event, append/update the history point
    // linked to that event (keyed on moneyEventId + assetId).
    if (context?.moneyEventId) {
      await this.assetsRepository.insertAssetValueHistory({
        id: this.assetsRepository.createId('valuation'),
        assetId: asset.id,
        householdId: asset.householdId,
        valuationDate: context.valuationDate ?? todayInTimeZone(),
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
   * today plus the `current_value` cache. Unlike a re-pricing, creating an asset
   * logs NO money event (it moves no money), so this point carries no
   * `moneyEventId`. Runs inside the create transaction (shared connection).
   */
  private async writeInitialValuation(asset: Asset): Promise<number> {
    const marketPrices = await this.marketData.getMarketPrices();
    const fxRates = await this.assetsRepository.getFxRates();
    const value = computeCurrentValue(
      asset,
      marketPrices,
      fxRates,
      todayInTimeZone(),
    );

    await this.assetsRepository.insertAssetValueHistory({
      id: this.assetsRepository.createId('valuation'),
      assetId: asset.id,
      householdId: asset.householdId,
      valuationDate: todayInTimeZone(),
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
