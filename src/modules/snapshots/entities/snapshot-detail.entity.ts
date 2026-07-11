import type {
  SnapshotStatus,
  SnapshotSourceMode,
} from '../../../common/utils/money-space.utils';

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
  // Derived at read time, not stored (see money-space.utils).
  status: SnapshotStatus;
  sourceMode: SnapshotSourceMode;
  note?: string;
  createdAt: string;
  items: SnapshotAssetLine[];
}
