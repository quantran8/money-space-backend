import type {
  FinancialGoal,
  GoalAssetAllocation,
} from '../entities/financial-goal.entity';
import type { Household } from '../../households/entities/household.entity';

export const GOALS_REPOSITORY = Symbol('GOALS_REPOSITORY');

export interface GoalsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  findFinancialGoalsByHousehold(householdId: string): Promise<FinancialGoal[]>;
  findFinancialGoalById(
    householdId: string,
    goalId: string,
  ): Promise<FinancialGoal | undefined>;
  insertFinancialGoal(goal: FinancialGoal): Promise<void>;
  updateFinancialGoal(goalId: string, goal: FinancialGoal): Promise<void>;
  /**
   * Rewrite only the pace mirror. Narrow on purpose: it is called after every
   * allocation write, where nothing else about the goal is being edited, and a
   * full-row update would carry whatever the caller last read.
   */
  updatePlannedMonthlyContribution(
    householdId: string,
    goalId: string,
    plannedMonthlyContribution: number | null,
  ): Promise<void>;
  deleteFinancialGoal(goalId: string): Promise<void>;
  unlinkFinancialGoalFromMoneyEvents(
    householdId: string,
    goalId: string,
  ): Promise<void>;

  /**
   * Every live allocation in the household, across all goals.
   *
   * Read in one query rather than per goal: the goals list resolves progress
   * for N goals at once, and the over-allocation check needs every claim
   * against an asset regardless of which goal made it.
   */
  findAllocationsByHousehold(
    householdId: string,
  ): Promise<GoalAssetAllocation[]>;
  findAllocationsByGoal(
    householdId: string,
    goalId: string,
  ): Promise<GoalAssetAllocation[]>;
  /**
   * Every live claim over ONE asset, whichever goal made it.
   *
   * Answers "what breaks if this asset goes away?" — the question the asset
   * delete flow has to put to the household before it does anything. Unlike the
   * two reads above, this one does NOT skip deleted assets: the caller is
   * asking ABOUT an asset that is on its way out, so filtering it would always
   * return nothing.
   */
  findAllocationsByAsset(
    householdId: string,
    assetId: string,
  ): Promise<GoalAssetAllocation[]>;
  /**
   * `asset_purchase` events whose source AND destination both belong to the
   * given assets — money that changed form inside one goal rather than leaving
   * it. Feeds `buildConversionCredit`.
   */
  findGoalConversionPurchases(
    householdId: string,
    assetIds: string[],
  ): Promise<Array<{ date: string; amount: number }>>;
  findAllocationById(
    householdId: string,
    allocationId: string,
  ): Promise<GoalAssetAllocation | undefined>;
  insertAllocation(allocation: GoalAssetAllocation): Promise<void>;
  updateAllocation(
    allocationId: string,
    allocation: GoalAssetAllocation,
  ): Promise<void>;
  deleteAllocation(householdId: string, allocationId: string): Promise<void>;
  /** Soft-delete every allocation of a goal — used when the goal is deleted. */
  deleteAllocationsByGoal(householdId: string, goalId: string): Promise<void>;
  /**
   * Soft-delete every claim over one asset — used when the asset is deleted.
   *
   * The mirror of `deleteAllocationsByGoal`, for the other end of the relation.
   * Needed because assets are soft-deleted, so the `onDelete: Cascade` on this
   * relation never fires and the claims would outlive what they claim.
   *
   * Leaves `financial_goals.planned_monthly_contribution` stale by design — it
   * is a mirror of the surviving claims, and only the caller knows which goals
   * to recompute. See `AssetsService.deleteAsset`.
   */
  deleteAllocationsByAsset(householdId: string, assetId: string): Promise<void>;
}
