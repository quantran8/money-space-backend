import { Inject, Injectable } from '@nestjs/common';
import { AS_OF } from '../../common/seed/money-space.seed';
import {
  computeCurrentValue,
  computeLiquidityTotals,
  formatCompactMillions,
  formatDateLabel,
  toGoalCard,
  toMoneyEventCard,
  toPaymentCard,
} from '../../common/utils/money-space.utils';
import { DASHBOARD_REPOSITORY } from './repositories/dashboard.repository.interface';
import type { DashboardRepository } from './repositories/dashboard.repository.interface';

@Injectable()
export class DashboardService {
  constructor(
    @Inject(DASHBOARD_REPOSITORY)
    private readonly dashboardRepository: DashboardRepository,
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
    ] = await Promise.all([
      this.dashboardRepository.assertHousehold(householdId),
      this.dashboardRepository.findAssetsByHousehold(householdId),
      this.dashboardRepository.getMarketPrices(),
      this.dashboardRepository.getFxRates(),
      this.dashboardRepository.getAttentionItems(householdId),
      this.dashboardRepository.findUpcomingPaymentsByHousehold(householdId),
      this.dashboardRepository.findFinancialGoalsByHousehold(householdId),
      this.dashboardRepository.findMoneyEventsByHousehold(householdId),
      this.dashboardRepository.getSnapshotsByHousehold(householdId),
    ]);
    const assets = householdAssets.map((asset) => ({
        ...asset,
        currentValue: computeCurrentValue(
          asset,
          marketPrices,
          fxRates,
          AS_OF,
        ),
      }));

    const totals = computeLiquidityTotals(assets);
    const totalDebt = 18_000_000;

    return {
      household,
      snapshot: {
        updatedAt: formatDateLabel(AS_OF),
        liquid: `${(totals.usable_now / 1_000_000).toFixed(1)}`,
        liquidDisplay: formatCompactMillions(totals.usable_now),
        liquidSplit: {
          cash: formatCompactMillions(
            assets
              .filter((asset) => asset.type === 'cash')
              .reduce((sum, asset) => sum + asset.currentValue, 0),
          ),
          account: formatCompactMillions(
            assets
              .filter((asset) => asset.type === 'bank_account')
              .reduce((sum, asset) => sum + asset.currentValue, 0),
          ),
        },
        savings: formatCompactMillions(totals.not_immediately_usable),
        debt: formatCompactMillions(totalDebt),
        netWorth: totals.totalAssets - totalDebt,
        netWorthDisplay: formatCompactMillions(totals.totalAssets - totalDebt),
        attentionCount: attentionItems.length,
      },
      payments: upcomingPayments.map((payment) => toPaymentCard(payment)),
      goals: financialGoals.map((goal) => toGoalCard(goal)),
      assetGroups: [
        {
          name: 'Co the dung ngay',
          value: formatCompactMillions(totals.usable_now),
          note: 'Tien mat, VCB',
        },
        {
          name: 'Tiet kiem & du phong',
          value: formatCompactMillions(totals.not_immediately_usable),
          note: 'So tiet kiem, quy du phong',
        },
        {
          name: 'Dai han',
          value: formatCompactMillions(totals.long_term),
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
