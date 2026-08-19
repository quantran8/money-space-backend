export interface WhatIfRequestDto {
  /** Must be positive. */
  amount: number;
  /** Must fall inside the forecast horizon. */
  plannedDate: string;
  /** Optional: show the time cost against a specific goal. */
  goalId?: string;
  label?: string;
  /**
   * `true` when the money would come straight out of what's saved for the goal
   * (so progress drops); `false` when it displaces future contributions.
   * See 05 §5.
   *
   * Preview only — this endpoint persists nothing (§26D). The real action is an
   * `expense`: for an `earmark` goal it carries `financialGoalId` and shrinks
   * the claim in the same transaction; for an `asset_backed` goal it simply
   * debits the asset and progress follows on the next read.
   */
  takeFromGoal?: boolean;
  horizonDays?: number;
}
