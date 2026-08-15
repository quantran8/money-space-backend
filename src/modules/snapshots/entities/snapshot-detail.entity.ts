import type { SnapshotSourceMode } from '../../../common/utils/money-space.utils';
import type { FinancialState } from '../../forecast/domain/financial-state';
import type { SnapshotFinancialStateReason } from '../domain/snapshot-financial-state';

export interface SnapshotAssetLine {
  id: string;
  assetId: string;
  assetName: string;
  assetType: string;
  liquidity: string;
  value: number;
  currency: string;
  valuationId?: string;
  valuationMethod?: string;
  valuationDate?: string;
  visibilityLevel: string;
  /** Frozen (§17) — who was responsible for this at snapshot time. */
  holderMemberId?: string | null;
}

export interface SnapshotDetail {
  id: string;
  householdId: string;
  snapshotDate: string;
  totalLiquid: number;
  totalSavings: number;
  totalLongTermAssets: number;
  totalDebt: number;
  upcomingDueAmount: number;
  attentionCount: number;

  // --- frozen foresight context (§10) -------------------------------------
  protectedReserveAmount: number;
  forecastHorizonDays: number;
  upcomingIncomeAmount: number;
  upcomingOutgoingAmount: number;
  /** Nullable (pre-v3.1 snapshots) and legitimately negative. */
  lowestProjectedBalance: number | null;
  flexibleMoney: number | null;

  /**
   * Derived at read time from the frozen columns, never stored — so changing
   * the derivation rule can't leave old rows asserting something the current
   * code disagrees with.
   */
  financialState: FinancialState;
  financialStateReasons: SnapshotFinancialStateReason[];
  sourceMode: SnapshotSourceMode;
  note?: string;
  createdAt: string;
  items: SnapshotAssetLine[];
}
