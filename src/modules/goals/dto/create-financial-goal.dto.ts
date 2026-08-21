import type { GoalPriority } from '../entities/financial-goal.entity';
import type { CreateGoalAllocationDto } from './goal-allocation.dto';

export interface CreateFinancialGoalDto {
  name: string;
  /**
   * Which assets count towards this goal, and by how much. **At least one is
   * required** — a goal with no assets behind it has no progress and no way to
   * gain any, so creating one would leave the household with a permanent 0%.
   *
   * "Set aside 100tr from shared money" is expressed here as a fixed 100tr
   * share of the wallet holding it: shared money is not a separate kind of
   * money, it is the household's `cash` / `bank_account` assets.
   */
  allocations: CreateGoalAllocationDto[];
  targetAmount: number;
  /**
   * No `plannedMonthlyContribution`. The pace is declared per wallet, on the
   * `allocations` above (`monthlyContribution`), and the goal's figure is their
   * sum — so a plan always names the accounts the money comes out of.
   */
  priority: GoalPriority;
  note?: string;
  targetDate?: string;
}
