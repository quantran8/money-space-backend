import type { GoalPriority } from '../entities/financial-goal.entity';

export interface CreateFinancialGoalDto {
  name: string;
  currentAmount?: number;
  targetAmount: number;
  priority: GoalPriority;
  note?: string;
  deadline?: string;
}
