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
  /**
   * Classification frozen alongside the value (§17). A later change to the
   * asset's nature/holder/privacy must not silently rewrite what a past
   * snapshot meant, so these travel WITH the line rather than being re-read
   * through the asset when the snapshot is displayed.
   */
  financialNature: string;
  holderMemberId?: string | null;
  privacyOwnerMemberId?: string | null;
}

/** Everything `POST /snapshots` freezes beyond the per-asset lines. */
export interface CreateSnapshotInput {
  id: string;
  householdId: string;
  snapshotDate: string;
  totalLiquid: number;
  totalSavings: number;
  totalLongTermAssets: number;
  totalDebt: number;
  upcomingDueAmount: number;
  attentionCount: number;
  protectedReserveAmount: number;
  forecastHorizonDays: number;
  upcomingIncomeAmount: number;
  upcomingOutgoingAmount: number;
  /** Nullable AND legitimately negative — a shortfall is the signal (§10). */
  lowestProjectedBalance: number | null;
  flexibleMoney: number | null;
  note?: string | null;
  createdById?: string | null;
  lines: SnapshotAssetLine[];
}

export interface SnapshotsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  /**
   * Active assets valued as of `asOfDate`, carrying their REAL classification.
   *
   * Distinct from the legacy `getActiveAssetLines`, which hardcoded
   * `visibilityLevel: 'detail'` — reusing that here would have frozen every
   * private asset into the snapshot as if it were shared.
   */
  getClassifiedAssetLines(
    householdId: string,
    asOfDate: string,
  ): Promise<SnapshotAssetLine[]>;
  getOutstandingDebtTotal(householdId: string): Promise<number>;
  /** When the household last took a snapshot — backs the rate limit. */
  getLastSnapshotCreatedAt(householdId: string): Promise<Date | null>;
  /**
   * Insert the snapshot, its lines and the audit entry as ONE transaction.
   * Exactly three statements: everything expensive (valuation, forecast) has
   * already run outside it.
   */
  createSnapshot(input: CreateSnapshotInput): Promise<void>;
  listSnapshots(householdId: string): Promise<SnapshotDetail[]>;
  getSnapshotById(
    householdId: string,
    snapshotId: string,
  ): Promise<SnapshotDetail | undefined>;
}
