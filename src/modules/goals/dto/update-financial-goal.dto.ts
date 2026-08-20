import type { CreateFinancialGoalDto } from './create-financial-goal.dto';

/**
 * `allocations` is omitted: which assets back a goal is edited through the
 * allocation routes (`…/allocations`), one claim at a time, so that each write
 * can be checked against what the asset still has free. Letting a goal PATCH
 * replace the whole set would either skip that check or silently drop claims
 * the caller did not mean to touch.
 */
export interface UpdateFinancialGoalDto extends Partial<
  Omit<CreateFinancialGoalDto, 'allocations'>
> {}
