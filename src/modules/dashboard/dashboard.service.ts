import { Inject, Injectable } from '@nestjs/common';
import { AS_OF } from '../../common/seed/money-space.seed';
import {
  computeCurrentValue,
  computeLiquidityTotals,
  formatDateLabel,
  toGoalCard,
  toMoneyEventCard,
  toPaymentCard,
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
  ) {}

  async getDashboard(householdId: string) {
    const [
      household,
      householdAssets,
      marketPrices,
      fxRates,
      attentionItems,
      upcomingPayments,
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
      this.dashboardRepository.findUpcomingPaymentsByHousehold(householdId),
      this.dashboardRepository.findFinancialGoalsByHousehold(householdId),
      this.dashboardRepository.findMoneyEventsByHousehold(householdId),
      this.dashboardRepository.getSnapshotsByHousehold(householdId),
      this.dashboardRepository.getOutstandingDebtTotal(householdId),
    ]);
    const assets = householdAssets.map((asset) => ({
      ...asset,
      currentValue: computeCurrentValue(asset, marketPrices, fxRates, AS_OF),
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
        updatedAt: formatDateLabel(AS_OF),
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
      payments: upcomingPayments.map((payment) => toPaymentCard(payment)),
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
      attentionItems: attentionItems.map((item) => ({
        title: item.title,
        reason: item.reason,
        level:
          item.level === 'important'
            ? 'Quan trọng'
            : item.level === 'urgent'
              ? 'Khẩn cấp'
              : 'Cần trao đổi',
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

  async listAttentionItems(householdId: string) {
    await this.dashboardRepository.assertHousehold(householdId);
    const items = await this.dashboardRepository.getAttentionItems(householdId);
    return {
      householdId,
      items,
      total: items.length,
    };
  }
}
