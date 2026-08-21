export type GoalPriority = 'high' | 'medium' | 'low';

export type GoalAllocationKind = 'fixed' | 'percent';

/**
 * What a share is FOR. Both count towards progress; only `contribution` counts
 * towards the monthly pace.
 *
 * `holding` is value already accumulated (gold, stocks) — it moves with the
 * market, which is not the household keeping or missing a pace. `contribution`
 * is the wallet money flows through, and a wallet has no market price.
 *
 * The household decides; the asset type only seeds the default.
 */
export type GoalAllocationRole = 'contribution' | 'holding';

/**
 * One asset's share of an `asset_backed` goal.
 *
 * Assets are claimed by the part, not whole: 100tr of stocks can send 50tr to
 * the car goal and leave the rest free. Exactly one of `allocatedAmount` /
 * `percent` is set, per `kind`.
 */
export interface GoalAssetAllocation {
  id: string;
  householdId: string;
  financialGoalId: string;
  assetId: string;
  kind: GoalAllocationKind;
  role: GoalAllocationRole;
  /**
   * The monthly pace this wallet is meant to feed the goal at, in VND.
   *
   * Only a `contribution` share of a `cash`/`bank_account` asset may carry one.
   * The goal's declared pace is the sum of these across its shares.
   */
  monthlyContribution: number | null;
  /**
   * This goal's share of the wallet's remaining monthly room, used only to split
   * a SHORTFALL between goals tied at the same priority. Never the contribution
   * itself — `monthlyContribution` stays the declared amount and the cap.
   *
   * `null` means the household was never asked, NOT 100: a tie among shares with
   * no figure falls back to splitting in proportion to the declared paces.
   */
  sharePercent: number | null;
  /** Set when `kind = 'fixed'`. A declared VND amount. */
  allocatedAmount: number | null;
  /** Set when `kind = 'percent'`. 0 < percent <= 100. */
  percent: number | null;
  note: string;
}

/**
 * Sentinel for "this goal has no target date".
 *
 * Kept as the literal string the wire format has always used, so the client
 * keeps rendering correctly while the frontend is migrated to `targetDate`.
 * When the client stops reading the legacy `deadline` field, this can become a
 * plain `null`.
 */
export const NO_TARGET_DATE = 'No deadline';

export interface FinancialGoal {
  id: string;
  householdId: string;
  name: string;
  targetAmount: number;
  /**
   * The declared pace — a MAINTAINED MIRROR of the goal's wallet shares, never
   * a client input. `GoalsService` rewrites it from
   * `resolvePlannedMonthlyContribution` in the same transaction as any
   * allocation write; it is stored so the goals list, the dashboard and the
   * forecast can show a pace without reading allocations at all.
   *
   * `null` or `<= 0` means "no pace planned" — show progress only, and never
   * divide by it unguarded.
   */
  plannedMonthlyContribution: number | null;
  /**
   * What the goal OPENED with — the contribution shares' fixed amounts at
   * creation, frozen once and never rewritten afterwards.
   *
   * The create form asks the opening balance and the monthly pace as two
   * separate questions; this is the answer to the first. It is the left-hand
   * side of the first month's subtraction in `buildGoalMonthlyProgress`, so a
   * goal created this month reports what has actually moved in since rather
   * than a blank.
   *
   * `null` for goals that predate it — their first month stays blank, as it was.
   */
  baselineContributionAmount: number | null;
  priority: GoalPriority;
  note: string;
  /** Renamed from `deadline` (spec §20). */
  targetDate: string;
}
