export type GoalPriority = 'high' | 'medium' | 'low';

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
  /**
   * STORED and the source of truth for progress (spec §20) — not derived from
   * `goal_contribution` money events.
   *
   * A household typically arrives with savings that predate the app, and there
   * is no honest event to invent for them; deriving would show 0. The column is
   * maintained by `MoneyEventsService` inside the same transaction as each
   * contribution (add / delta / reverse). See `memory/goals.md`.
   */
  currentAmount: number;
  targetAmount: number;
  /**
   * Drives the projection. `null` or `<= 0` means "no projected completion
   * date" — show progress only. Never divide by it unguarded.
   */
  plannedMonthlyContribution: number | null;
  priority: GoalPriority;
  note: string;
  /** Renamed from `deadline` (spec §20). */
  targetDate: string;
}
