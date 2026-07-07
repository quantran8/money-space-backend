export type GoalPriority = 'high' | 'medium' | 'low';

export interface FinancialGoal {
  id: string;
  householdId: string;
  name: string;
  currentAmount: number;
  targetAmount: number;
  priority: GoalPriority;
  note: string;
  deadline: string;
}
