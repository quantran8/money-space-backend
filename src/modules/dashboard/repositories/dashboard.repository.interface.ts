import type { Asset } from '../../assets/entities/asset.entity';
import type { AttentionItem } from '../entities/attention-item.entity';
import type { SnapshotPoint } from '../entities/snapshot-point.entity';
import type { FinancialGoal } from '../../goals/entities/financial-goal.entity';
import type { Household } from '../../households/entities/household.entity';
import type { FxRate } from '../../market-data/entities/fx-rate.entity';
import type { MoneyEvent } from '../../money-events/entities/money-event.entity';
import type { UpcomingPayment } from '../../payments/entities/upcoming-payment.entity';

export const DASHBOARD_REPOSITORY = Symbol('DASHBOARD_REPOSITORY');

export interface DashboardRepository {
  assertHousehold(householdId: string): Promise<Household>;
  findAssetsByHousehold(householdId: string): Promise<Asset[]>;
  getFxRates(): Promise<FxRate[]>;
  getAttentionItems(householdId?: string): Promise<AttentionItem[]>;
  findUpcomingPaymentsByHousehold(
    householdId: string,
  ): Promise<UpcomingPayment[]>;
  findFinancialGoalsByHousehold(householdId: string): Promise<FinancialGoal[]>;
  findMoneyEventsByHousehold(householdId: string): Promise<MoneyEvent[]>;
  getSnapshotsByHousehold(householdId: string): Promise<SnapshotPoint[]>;
  /** SUM(debts.outstanding_amount) for active, non-deleted debts. */
  getOutstandingDebtTotal(householdId: string): Promise<number>;
}
