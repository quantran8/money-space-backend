import type { Household } from '../../households/entities/household.entity';
import type { SnapshotDetail } from '../entities/snapshot-detail.entity';

export const SNAPSHOTS_REPOSITORY = Symbol('SNAPSHOTS_REPOSITORY');

export interface SnapshotAssetValueInput {
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

export interface SnapshotWriteInput {
  id: string;
  householdId: string;
  snapshotDate: string;
  totalLiquid: number;
  totalSavings: number;
  totalLongTermAssets: number;
  totalDebt: number;
  upcomingDueAmount: number;
  attentionCount: number;
  note?: string;
  assetValues: SnapshotAssetValueInput[];
}

export interface SnapshotsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;

  /** SUM(debts.outstanding_amount) for active, non-deleted debts. */
  getOutstandingDebtTotal(householdId: string): Promise<number>;
  /** SUM(upcoming_payments.amount) for unpaid, non-deleted payments. */
  getUpcomingDueTotal(householdId: string): Promise<number>;
  /** Count of open attention items. */
  getOpenAttentionCount(householdId: string): Promise<number>;

  /**
   * Atomically write the snapshot row, its per-asset frozen line items
   * (bulk `createMany`), and a `snapshot.created` audit log.
   */
  createSnapshot(input: SnapshotWriteInput): Promise<void>;

  listSnapshots(householdId: string): Promise<SnapshotDetail[]>;
  getSnapshotById(
    householdId: string,
    snapshotId: string,
  ): Promise<SnapshotDetail | undefined>;
}
