import {
  BadRequestException,
  Inject,
  Injectable,
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
import { AssetValuation } from './entities/asset-valuation.entity';
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

  /**
   * The asset's current `AssetValuation` (the AS_OF row upsertCurrentValuation
   * maintains), for a snapshot line to reference via `valuationId`. Returns
   * `undefined` if none exists — the snapshot line stays self-contained (it
   * still freezes the value); it just loses the lineage back-pointer.
   */
  async getCurrentValuation(assetId: string) {
    return this.assetsRepository.findAssetValuation(assetId, AS_OF);
  }

  /**
   * Reconstruct the asset's value over time. There is no historical valuation
   * series yet — `upsertCurrentValuation` only ever writes a single row at
   * `AS_OF` — so we take today's value and unwind the asset's money events
   * backwards to recover the value that held before each.
   *
   * How a value is recovered depends on the valuation mode:
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

    const events = await this.assetsRepository.findMoneyEventsByAsset(
      householdId,
      assetId,
    );

    const points =
      asset.valuationMode === 'market_priced' && asset.marketPosition
        ? this.buildMarketValueHistory(asset, currentValue, events)
        : this.buildCashValueHistory(assetId, currentValue, events);

    // Collapse duplicate dates, keeping the last value recorded on a day.
    const byDate = new Map<string, number>();
    for (const point of points) {
      byDate.set(point.date, point.value);
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
    const unitPrice = currentQuantity > 0 ? currentValue / currentQuantity : 0;

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
          value: Math.max(0, quantity * unitPrice),
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
    await this.upsertCurrentValuation(next);
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
    await this.upsertCurrentValuation(next);
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
      } else {
        next.manualValue = 0;
      }
    }

    await this.assetsRepository.updateAsset(assetId, next);
    await this.upsertCurrentValuation(next);
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
    } else {
      next.manualValue = (asset.manualValue ?? 0) + (sale.valueSold ?? 0);
    }

    // Reopen an asset that the sale had closed.
    if (asset.status === 'sold') {
      next.status = 'active';
      next.soldAt = undefined;
    }

    await this.assetsRepository.updateAsset(assetId, next);
    await this.upsertCurrentValuation(next);
  }

  /** Fetch the raw asset entity (with its calculation term). Used by accrual. */
  async getAssetEntity(householdId: string, assetId: string): Promise<Asset> {
    return this.ensureAsset(householdId, assetId);
  }

  /**
   * Write an `AssetValuation` for a saving deposit dated at an interest payout,
   * for the auto-crediting flow. Unlike {@link upsertCurrentValuation} (which
   * only ever writes at `AS_OF`), this records a dated point in the deposit's
   * valuation history — one per credited period. Idempotent per date: an
   * existing row at `valuationDate` is updated in place. Runs inside the
   * caller's transaction.
   */
  async writeSavingValuationAt(
    asset: Asset,
    valuationDate: string,
    value: number,
  ): Promise<void> {
    const existing = await this.assetsRepository.findAssetValuation(
      asset.id,
      valuationDate,
    );
    if (existing) {
      existing.value = value;
      existing.currency = asset.currency;
      existing.method = 'formula_calculated';
      existing.note = asset.note;
      await this.assetsRepository.insertAssetValuation(existing);
      return;
    }
    await this.assetsRepository.insertAssetValuation({
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

    // Lineage: where the number came from + how much we trust it.
    // `manual` = user-entered (high confidence, no external source); `formula`
    // ties back to the calculation term; `market_priced` will carry
    // marketPriceId/fxRateId once a pricing-API writer populates those tables.
    const source =
      asset.valuationMode === 'manual'
        ? 'user'
        : asset.valuationMode === 'market_priced'
          ? 'market_price_api'
          : 'formula';
    const confidenceLevel: AssetValuation['confidenceLevel'] =
      asset.valuationMode === 'manual' ? 'high' : 'medium';
    // marketPriceId/fxRateId/calculationTermId stay null until their source rows
    // are wired (pricing-API writer; term id exposed on the entity).

    if (existing) {
      existing.value = value;
      existing.currency = asset.currency;
      existing.method = method;
      existing.note = asset.note;
      existing.source = source;
      existing.confidenceLevel = confidenceLevel;
      await this.assetsRepository.insertAssetValuation(existing);
    } else {
      await this.assetsRepository.insertAssetValuation({
        id: this.assetsRepository.createId('valuation'),
        assetId: asset.id,
        householdId: asset.householdId,
        valuationDate: AS_OF,
        value,
        currency: asset.currency,
        method,
        note: asset.note,
        source,
        confidenceLevel,
      });
    }

    // Keep the `assets.current_value` cache in sync for EVERY mode (the plain
    // create/update path only wrote `manualValue`, leaving derived assets stale).
    await this.assetsRepository.updateAssetCurrentValue(asset.id, value);

    return value;
  }
}
