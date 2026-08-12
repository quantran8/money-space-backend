import type { GoalPriority } from '../entities/financial-goal.entity';

export interface CreateFinancialGoalDto {
  name: string;
  /**
   * What the household has already put aside for this goal.
   *
   * Accepted ON CREATE only, because onboarding must be able to record an
   * existing balance ("we already have 200M toward the house"). It is
   * deliberately rejected on UPDATE — after creation the only thing that may
   * move this number is a `goal_contribution` money event, so the stored column
   * and the event history cannot diverge.
   */
  currentAmount?: number;
  targetAmount: number;
  plannedMonthlyContribution?: number;
  priority: GoalPriority;
  note?: string;
  targetDate?: string;
}
