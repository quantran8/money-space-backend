import type { CreateFinancialGoalDto } from './create-financial-goal.dto';

/**
 * `currentAmount` is omitted on purpose: once a goal exists, its progress may
 * only change through a `goal_contribution` money event, which updates the
 * column inside the same transaction. Allowing a direct edit here would let the
 * stored total silently diverge from the contribution history.
 */
export interface UpdateFinancialGoalDto
  extends Partial<Omit<CreateFinancialGoalDto, 'currentAmount'>> {}
