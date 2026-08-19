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
  /**
   * Frozen alongside the value (§17). Reclassifying an asset later must not
   * silently rewrite what a past snapshot meant, so these travel WITH the line
   * rather than being re-read through the asset when the snapshot is displayed.
   *
   * What a line remembers is who was responsible for the money.
   */
  holderMemberId?: string | null;
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
  forecastHorizonDays: number;
  upcomingIncomeAmount: number;
  upcomingOutgoingAmount: number;
  /** Nullable AND legitimately negative — a shortfall is the signal (§10). */
  lowestProjectedBalance: number | null;
  flexibleMoney: number | null;
  note?: string | null;
  createdById?: string | null;
  lines: SnapshotAssetLine[];
  /**
   * Each goal's progress at snapshot time. Frozen because it cannot be
   * recomputed later — allocations carry no history, so adding an asset today
   * would retroactively raise every past month.
   */
  goalLines: SnapshotGoalLine[];
}

/** One goal's progress, frozen alongside the asset lines. */
export interface SnapshotGoalLine {
  financialGoalId: string;
  goalName: string;
  targetAmount: number;
  progressAmount: number;
  /**
   * The `contribution`-role part of `progressAmount`. Frozen separately so the
   * monthly pace can be read without the market movement that rides along in
   * the total — see `resolveContributionProgressAmount`.
   */
  contributionProgressAmount: number;
}

export interface SnapshotsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  /** Active assets valued as of `asOfDate`, with their holder metadata. */
  getClassifiedAssetLines(
    householdId: string,
    asOfDate: string,
  ): Promise<SnapshotAssetLine[]>;
  /**
   * Each goal's progress right now, resolved from its allocations against the
   * same live asset values the asset lines were built from — so a goal and the
   * assets behind it can never disagree within one snapshot.
   */
  getGoalLines(householdId: string): Promise<SnapshotGoalLine[]>;
  /**
   * One goal's frozen progress across snapshots, oldest first. Feeds
   * `buildGoalMonthlyProgress`.
   */
  findGoalProgressPoints(
    householdId: string,
    goalId: string,
  ): Promise<
    Array<{
      date: string;
      progressAmount: number;
      /** Null on points frozen before contributions were tracked separately. */
      contributionAmount: number | null;
    }>
  >;
  /**
   * The most recent frozen point BEFORE `beforeDate`, with that snapshot's
   * per-asset values — the basis for explaining why the goal's figure moved.
   * Null when the goal has no earlier point.
   */
  findGoalProgressChangeBasis(
    householdId: string,
    goalId: string,
    beforeDate: string,
  ): Promise<{
    date: string;
    progressAmount: number;
    assets: Array<{ assetId: string; assetName: string; value: number }>;
  } | null>;
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
