import type { Household } from '../../households/entities/household.entity';
import type { SnapshotDetail } from '../entities/snapshot-detail.entity';

export const SNAPSHOTS_REPOSITORY = Symbol('SNAPSHOTS_REPOSITORY');

export interface SnapshotAssetLine {
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

export interface SnapshotsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;

  /** SUM(debts.outstanding_amount) for active, non-deleted debts. */
  getOutstandingDebtTotal(householdId: string): Promise<number>;
  /** SUM(upcoming_payments.amount) for unpaid, non-deleted payments. */
  getUpcomingDueTotal(householdId: string): Promise<number>;
  /** Count of open attention items. */
  getOpenAttentionCount(householdId: string): Promise<number>;

  /** All active assets valued as snapshot line items (full seed set). */
  getActiveAssetLines(householdId: string): Promise<SnapshotAssetLine[]>;
  /**
   * One active asset valued as a line, or `undefined` when it no longer counts
   * (deleted / sold / not active) — the caller then removes its snapshot line.
   */
  getActiveAssetLine(
    householdId: string,
    assetId: string,
  ): Promise<SnapshotAssetLine | undefined>;

  /**
   * Ensure today's (household-timezone) snapshot exists; seed a FULL set of
   * per-asset line items on first creation. Idempotent — returns the existing
   * snapshot id on subsequent calls the same day. Days before today are never
   * touched (immutable).
   */
  ensureTodaySnapshot(householdId: string, today: string): Promise<string>;

  /** Upsert one asset's frozen line (INSERT … ON CONFLICT (snapshot_id, asset_id)). */
  upsertAssetLine(
    snapshotId: string,
    householdId: string,
    line: SnapshotAssetLine,
  ): Promise<void>;

  /** Remove one asset's line from a snapshot (hard delete — child isn't soft-deleted). */
  removeAssetLine(snapshotId: string, assetId: string): Promise<void>;

  /**
   * Recompute the parent totals from the CURRENT child rows (SUM … GROUP BY
   * liquidity) plus household-level debt / upcoming / attention — so the parent
   * totals always equal the sum of the children.
   */
  recomputeSnapshotTotals(
    snapshotId: string,
    householdId: string,
  ): Promise<void>;

  listSnapshots(householdId: string): Promise<SnapshotDetail[]>;
  getSnapshotById(
    householdId: string,
    snapshotId: string,
  ): Promise<SnapshotDetail | undefined>;
}
