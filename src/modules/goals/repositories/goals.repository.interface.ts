import type { FinancialGoal } from '../entities/financial-goal.entity';
import type { Household } from '../../households/entities/household.entity';

export const GOALS_REPOSITORY = Symbol('GOALS_REPOSITORY');

export interface GoalsRepository {
  assertHousehold(householdId: string): Promise<Household>;
  createId(prefix: string): string;
  findFinancialGoalsByHousehold(householdId: string): Promise<FinancialGoal[]>;
  findFinancialGoalById(householdId: string, goalId: string): Promise<FinancialGoal | undefined>;
  insertFinancialGoal(goal: FinancialGoal): Promise<void>;
  updateFinancialGoal(goalId: string, goal: FinancialGoal): Promise<void>;
  deleteFinancialGoal(goalId: string): Promise<void>;
  unlinkFinancialGoalFromMoneyEvents(goalId: string): Promise<void>;
}
