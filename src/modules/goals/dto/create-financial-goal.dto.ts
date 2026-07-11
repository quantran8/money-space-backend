import type { GoalPriority } from '../entities/financial-goal.entity';

export interface CreateFinancialGoalDto {
  name: string;
  // No currentAmount: progress is derived from goal_contribution money events.
  targetAmount: number;
  priority: GoalPriority;
  note?: string;
  deadline?: string;
}
