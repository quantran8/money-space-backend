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
import { DASHBOARD_REPOSITORY } from './repositories/dashboard.repository.interface';
import type { DashboardRepository } from './repositories/dashboard.repository.interface';
import { MarketDataService } from '../market-data/market-data.service';

@Injectable()
export class DashboardService {
  constructor(
    @Inject(DASHBOARD_REPOSITORY)
    private readonly dashboardRepository: DashboardRepository,
    private readonly marketData: MarketDataService,
    private readonly assets: AssetsService,
  ) {}

  async getDashboard(householdId: string) {
    // Fire-and-forget: the first dashboard hit of the day for a household kicks
    // off a market-price refresh in the background (deduped + gated to once/day
    // inside the service). We do NOT await it — this response returns today's
    // cached values immediately; the refreshed prices land for the next load.
    void this.assets
      .refreshMarketValuationsIfStale(householdId)
      .catch(() => undefined);

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
    ] = await Promise.all([
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
    ]);
    const assets = householdAssets.map((asset) => ({
      ...asset,
      currentValue: computeCurrentValue(asset, marketPrices, fxRates, todayInTimeZone()),
    }));

    // Live "current net worth" is computed on the fly (never read from the
    // latest snapshot) so the header reflects today's asset values + debt,
    // not the last snapshot cadence. Same debt source the snapshot writer uses.
    const totals = computeLiquidityTotals(assets);

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
        attentionCount: attentionItems.length,
      },
      // Raw cashflow events; the client renders them. The forecast
      // endpoints (Phase 3) are what turn these into a timeline.
      payments: cashflowEvents,
      goals: financialGoals.map((goal) => toGoalCard(goal)),
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
