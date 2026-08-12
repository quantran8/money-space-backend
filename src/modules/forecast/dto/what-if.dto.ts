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
   * (so `currentAmount` drops); `false` when it displaces future contributions.
   * See 05 §5.
   */
  takeFromGoal?: boolean;
  horizonDays?: number;
}
