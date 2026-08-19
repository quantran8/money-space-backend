import { Inject, Injectable } from '@nestjs/common';
import { AssetsService } from '../assets/assets.service';
import { todayInTimeZone } from '../../common/utils/clock';
import {
  computeCurrentValue,
  computeLiquidityTotals,
  formatDateLabel,
  toGoalCard,
  toMoneyEventCard,
} from '../../common/utils/money-space.utils';
import { resolveGoalProgressAmount } from '../goals/domain/goal-progress';
import { DASHBOARD_REPOSITORY } from './repositories/dashboard.repository.interface';
import type { DashboardRepository } from './repositories/dashboard.repository.interface';
import { MarketDataService } from '../market-data/market-data.service';
import { CacheService } from '../../common/cache/cache.service';
import { cacheKeys, cacheTtl } from '../../common/cache/cache.keys';

@Injectable()
export class DashboardService {
  constructor(
    @Inject(DASHBOARD_REPOSITORY)
    private readonly dashboardRepository: DashboardRepository,
    private readonly marketData: MarketDataService,
    private readonly assets: AssetsService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Cached read-through. The uncached path fans out to ten queries, so this is
   * the highest-value cache in the app; entries are dropped by
   * `CacheInvalidator` on any write to the household, with `cacheTtl.household`
   * as a backstop.
   */
  async getDashboard(householdId: string) {
    // Deliberately OUTSIDE the cached region: this is the authorization /
    // existence check, and a cache hit must never let a caller skip it.
    // It also throws for an unknown household before any cache key is built.
    await this.dashboardRepository.assertHousehold(householdId);

    // Fire-and-forget: the first dashboard hit of the day for a household kicks
    // off a market-price refresh in the background (deduped + gated to once/day
    // inside the service). We do NOT await it — this response returns today's
    // cached values immediately; the refreshed prices land for the next load.
    void this.assets
      .refreshMarketValuationsIfStale(householdId)
      .catch(() => undefined);

    return this.cache.wrap(
      cacheKeys.dashboard(householdId),
      () => this.buildDashboard(householdId),
      cacheTtl.household,
    );
  }

  private async buildDashboard(householdId: string) {
    const [
      household,
      householdAssets,
      marketPrices,
      fxRates,
      attentionItems,
      cashflowEvents,
      financialGoals,
      moneyEvents,
      snapshots,
      totalDebt,
      goalAllocations,
    ] = await Promise.all([
      // `assertHousehold` already ran in `getDashboard`; re-fetch the row for
      // the payload without repeating the check.
      this.dashboardRepository.assertHousehold(householdId),
      this.dashboardRepository.findAssetsByHousehold(householdId),
      this.marketData.getMarketPrices(),
      this.dashboardRepository.getFxRates(),
      this.dashboardRepository.getAttentionItems(householdId),
      this.dashboardRepository.findCashflowEventsByHousehold(householdId),
      this.dashboardRepository.findFinancialGoalsByHousehold(householdId),
      this.dashboardRepository.findMoneyEventsByHousehold(householdId),
      this.dashboardRepository.getSnapshotsByHousehold(householdId),
      this.dashboardRepository.getOutstandingDebtTotal(householdId),
      this.dashboardRepository.findGoalAllocationsByHousehold(householdId),
    ]);
    const assets = householdAssets.map((asset) => ({
      ...asset,
      currentValue: computeCurrentValue(
        asset,
        marketPrices,
        fxRates,
        todayInTimeZone(),
      ),
    }));

    // Live "current net worth" is computed on the fly (never read from the
    // latest snapshot) so the header reflects today's asset values + debt,
    // not the last snapshot cadence. Same debt source the snapshot writer uses.
    const totals = computeLiquidityTotals(assets);

    // How much of the household's money already has a job.
    //
    // This is a DISPLAY split, not a deduction: `netWorth` below is untouched,
    // and flexible money keeps its own formula. Setting money aside for a goal
    // does not make a household poorer, and subtracting earmarks from the
    // headline figure is the shape that got `protected_reserves` removed —
    // a goal with a monthly contribution is already pulled down by the
    // forecast, so subtracting it here too would count it twice.
    const assetValues = new Map(
      assets.map((asset) => [asset.id, asset.currentValue]),
    );
    const progressOf = (goal: (typeof financialGoals)[number]) =>
      resolveGoalProgressAmount(
        goalAllocations
          .filter((allocation) => allocation.financialGoalId === goal.id)
          .map((allocation) => ({
            assetId: allocation.assetId,
            kind: allocation.kind,
            allocatedAmount: allocation.allocatedAmount,
            percent: allocation.percent,
          })),
        assetValues,
      );
    // Every goal the household still has: `status` is not carried on the entity
    // (the repository already excludes soft-deleted rows), and a completed goal
    // is money that is still set aside anyway — it has not been spent yet.
    const goalProgressAmounts = financialGoals.map(progressOf);
    // No cap needed: a goal is a set of shares of assets, each bounded by its
    // asset's live value, and no asset can be over-allocated across goals
    // (`GoalsService.assertWithinAssetValue`). So the sum is structurally at
    // most `totalAssets`. The previous `Math.min` existed only to contain an
    // earmark figure, which was a bare declaration and could outrun what the
    // household actually held; with that gone the clamp would only hide a bug.
    const earmarkedForGoals = goalProgressAmounts.reduce(
      (sum, amount) => sum + amount,
      0,
    );

    return {
      household,
      // All money values are raw numbers (VND); the client formats them for
      // display.
      snapshot: {
        updatedAt: formatDateLabel(todayInTimeZone()),
        liquid: totals.usable_now,
        liquidSplit: {
          cash: assets
            .filter((asset) => asset.type === 'cash')
            .reduce((sum, asset) => sum + asset.currentValue, 0),
          account: assets
            .filter((asset) => asset.type === 'bank_account')
            .reduce((sum, asset) => sum + asset.currentValue, 0),
        },
        savings: totals.not_immediately_usable,
        debt: totalDebt,
        netWorth: totals.totalAssets - totalDebt,
        // The display split described above. `netWorth` is deliberately NOT
        // reduced by these — they say where the money is pointed, not that it
        // is gone.
        earmarkedForGoals,
        unassigned: Math.max(0, totals.totalAssets - earmarkedForGoals),
        attentionCount: attentionItems.length,
      },
      // Raw cashflow events; the client renders them. The forecast
      // endpoints (Phase 3) are what turn these into a timeline.
      payments: cashflowEvents,
      // Each card carries its resolved progress, so an asset_backed goal on the
      // dashboard shows what its assets are worth rather than an unused column.
      goals: financialGoals.map((goal) => toGoalCard(goal, progressOf(goal))),
      assetGroups: [
        {
          name: 'Co the dung ngay',
          value: totals.usable_now,
          note: 'Tien mat, VCB',
        },
        {
          name: 'Tiet kiem & du phong',
          value: totals.not_immediately_usable,
          note: 'So tiet kiem, quy du phong',
        },
        {
          name: 'Dai han',
          value: totals.long_term,
          note: 'Vang, crypto, dau tu',
        },
      ],
      // Levels are emitted as CODES (`normal | important | urgent`), never as
      // Vietnamese labels. The client owns all copy — it has a hard i18n
      // mandate, and a backend-rendered "Khẩn cấp" cannot be translated,
      // restyled, or softened per §29's tone rules.
      attentionItems: attentionItems.map((item) => ({
        title: item.title,
        reason: item.reason,
        level: item.level,
      })),
      recentEvents: moneyEvents.map((event) => toMoneyEventCard(event)),
      assetTrend: snapshots.map((snapshot) => ({
        date: snapshot.date,
        usable_now: snapshot.usableNow,
        not_immediately_usable: snapshot.notImmediatelyUsable,
        long_term: snapshot.longTerm,
      })),
    };
  }
}
