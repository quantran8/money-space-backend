/**
 * Goal projection (spec §26C, §20, 05 §4).
 *
 * Turns a goal into a date: "at this pace, when do we get there?" and "what
 * would it take to hit the date we want?"
 *
 * Deliberately simple — **no investment-return assumptions** (§26C). Projecting
 * growth would make the date look better than the household's actual behaviour
 * justifies, which is the opposite of the honesty the product promises.
 *
 * Pure: `asOfDate` is passed in; nothing reads the clock.
 */

import {
  addMonthsIso,
  monthsBetweenIso,
  type IsoDate,
} from '../../../common/utils/clock';

export type GoalProjectionReason =
  | 'ok'
  | 'already_complete'
  | 'no_contribution'
  | 'no_target_date'
  | 'target_date_passed'
  | 'goal_inactive';

export interface GoalProjectionInput {
  goalId: string;
  targetAmount: number;
  /** The STORED current amount — the source of truth (§20). */
  currentAmount: number;
  plannedMonthlyContribution: number | null;
  targetDate: IsoDate | null;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  asOfDate: IsoDate;
}

export interface GoalProjection {
  goalId: string;
  targetAmount: number;
  currentAmount: number;
  remainingAmount: number;
  progressPercent: number;
  plannedMonthlyContribution: number | null;
  estimatedMonthsToGoal: number | null;
  projectedCompletionDate: IsoDate | null;
  targetDate: IsoDate | null;
  monthsUntilTargetDate: number | null;
  /** The Goals-screen number: "to hit Jun 2029, add ~X/month" (04 §8). */
  requiredMonthlyContributionForTargetDate: number | null;
  onPaceForTargetDate: boolean | null;
  /** Positive = projected to land later than the target date. */
  paceGapMonths: number | null;
  reason: GoalProjectionReason;
}

export function projectGoal(input: GoalProjectionInput): GoalProjection {
  const {
    goalId,
    targetAmount,
    currentAmount,
    plannedMonthlyContribution,
    targetDate,
    status,
    asOfDate,
  } = input;

  const remainingAmount = Math.max(0, targetAmount - currentAmount);
  const progressPercent =
    targetAmount <= 0
      ? 0
      : Math.min(100, Math.round((currentAmount / targetAmount) * 100));

  const base = {
    goalId,
    targetAmount,
    currentAmount,
    remainingAmount,
    progressPercent,
    plannedMonthlyContribution,
    targetDate,
    monthsUntilTargetDate: null as number | null,
    requiredMonthlyContributionForTargetDate: null as number | null,
    onPaceForTargetDate: null as boolean | null,
    paceGapMonths: null as number | null,
  };

  if (status !== 'active') {
    return {
      ...base,
      estimatedMonthsToGoal: null,
      projectedCompletionDate: null,
      reason: 'goal_inactive',
    };
  }

  // Checked BEFORE the contribution check: a fully funded goal is complete even
  // if nobody ever declared a monthly contribution.
  if (remainingAmount === 0) {
    return {
      ...base,
      estimatedMonthsToGoal: 0,
      projectedCompletionDate: asOfDate,
      reason: 'already_complete',
    };
  }

  const monthsUntilTargetDate = targetDate
    ? Math.max(0, monthsBetweenIso(asOfDate, targetDate))
    : null;

  // What it would take to hit the wanted date — computable even with no
  // declared contribution, and it is exactly the prompt the user needs.
  let requiredMonthlyContributionForTargetDate: number | null = null;
  if (targetDate) {
    requiredMonthlyContributionForTargetDate =
      monthsUntilTargetDate && monthsUntilTargetDate > 0
        ? Math.ceil(remainingAmount / monthsUntilTargetDate)
        : // Date already passed: the whole remainder would be needed now.
          remainingAmount;
  }

  // NEVER divide by a null/zero contribution. §20: with no declared
  // contribution, show progress only and invite the user to add one — inventing
  // a pace would fabricate a date.
  if (plannedMonthlyContribution === null || plannedMonthlyContribution <= 0) {
    return {
      ...base,
      monthsUntilTargetDate,
      requiredMonthlyContributionForTargetDate,
      estimatedMonthsToGoal: null,
      projectedCompletionDate: null,
      reason: 'no_contribution',
    };
  }

  // Ceil, not round: a partial month is still a month you have to live through.
  const estimatedMonthsToGoal = Math.ceil(
    remainingAmount / plannedMonthlyContribution,
  );
  const projectedCompletionDate = addMonthsIso(asOfDate, estimatedMonthsToGoal);

  const onPaceForTargetDate = targetDate
    ? projectedCompletionDate <= targetDate
    : null;
  const paceGapMonths =
    targetDate && monthsUntilTargetDate !== null
      ? estimatedMonthsToGoal - monthsUntilTargetDate
      : null;

  let reason: GoalProjectionReason = 'ok';
  if (!targetDate) {
    reason = 'no_target_date';
  } else if (monthsUntilTargetDate === 0) {
    reason = 'target_date_passed';
  }

  return {
    ...base,
    monthsUntilTargetDate,
    requiredMonthlyContributionForTargetDate,
    estimatedMonthsToGoal,
    projectedCompletionDate,
    onPaceForTargetDate,
    paceGapMonths,
    reason,
  };
}

/**
 * What a spend does to a goal (05 §5) — the "time cost" half of what-if.
 *
 * Two different situations:
 *
 * - `takenFromGoal` — the money comes straight out of what's saved, so
 *   `currentAmount` drops and the date is re-derived exactly.
 * - otherwise — the money was going to be contributed, so the delay is
 *   approximated as `spend / monthlyContribution` (05 §5.1).
 */
export function projectGoalAfterSpend(
  input: GoalProjectionInput,
  spendAmount: number,
  opts: { takenFromGoal: boolean },
): {
  projection: GoalProjection;
  goalDelayMonths: number | null;
  goalDelayDays: number | null;
} {
  const before = projectGoal(input);

  if (opts.takenFromGoal) {
    const projection = projectGoal({
      ...input,
      currentAmount: Math.max(0, input.currentAmount - spendAmount),
    });
    const goalDelayMonths =
      before.estimatedMonthsToGoal !== null &&
      projection.estimatedMonthsToGoal !== null
        ? projection.estimatedMonthsToGoal - before.estimatedMonthsToGoal
        : null;
    return {
      projection,
      goalDelayMonths,
      goalDelayDays:
        goalDelayMonths === null ? null : Math.round(goalDelayMonths * 30),
    };
  }

  const contribution = input.plannedMonthlyContribution;
  if (contribution === null || contribution <= 0) {
    // No declared pace → no honest way to express the delay in time.
    return { projection: before, goalDelayMonths: null, goalDelayDays: null };
  }

  const goalDelayMonths = Math.ceil(spendAmount / contribution);
  const shiftedMonths =
    before.estimatedMonthsToGoal === null
      ? null
      : before.estimatedMonthsToGoal + goalDelayMonths;

  return {
    projection: {
      ...before,
      estimatedMonthsToGoal: shiftedMonths,
      projectedCompletionDate:
        shiftedMonths === null
          ? null
          : addMonthsIso(input.asOfDate, shiftedMonths),
    },
    goalDelayMonths,
    goalDelayDays: Math.round(goalDelayMonths * 30),
  };
}

/**
 * How much later each goal lands because of one spend.
 *
 * The money cost is only half the answer the household is asking for. "Mục tiêu
 * giảm 3tr" says what leaves; "về đích chậm 2 tháng" says what it costs them,
 * and the second is the one that decides whether a purchase is worth it. What-if
 * already reported a delay, but only for one goal the household had to pick by
 * hand, and only under a manual "take from the goal?" flag.
 *
 * Now that a spend's cost is resolved per goal AND split into its two halves,
 * the delay follows for every affected goal without anyone choosing anything:
 *
 *  - **Money already set aside** going out means the goal has further to climb.
 *    It is re-projected from a lower balance.
 *  - **This month's contribution** being skipped does not lower the balance —
 *    it removes a month's worth of progress that had been counted on, so the
 *    finish line moves out by the fraction of a month that was given up.
 *
 * Both are expressed against the goal's own declared pace, so a goal with no
 * pace reports `null` rather than a fabricated month count: without a declared
 * pace there is no honest way to turn money into time.
 *
 * Pure: no clock, no database.
 */
export function projectGoalDelayFromSpend(
  input: GoalProjectionInput,
  cost: { paceReduction: number; setAsideReduction: number },
): {
  before: GoalProjection;
  after: GoalProjection;
  delayMonths: number | null;
  delayDays: number | null;
} {
  const before = projectGoal(input);
  const pace = input.plannedMonthlyContribution;

  // Set-aside money leaving lowers the balance, so the goal is simply further
  // from the target than it was.
  const after = projectGoal({
    ...input,
    currentAmount: Math.max(0, input.currentAmount - cost.setAsideReduction),
  });

  if (pace === null || pace <= 0) {
    // No declared pace: the balance change is still real and reported, but
    // there is no rate to convert it into time.
    return { before, after, delayMonths: null, delayDays: null };
  }

  // The set-aside half, in months: how long the pace takes to put it back.
  const fromSetAside =
    before.estimatedMonthsToGoal !== null && after.estimatedMonthsToGoal !== null
      ? after.estimatedMonthsToGoal - before.estimatedMonthsToGoal
      : cost.setAsideReduction / pace;

  // The skipped contribution, in months: the share of a month's saving given up.
  const fromPace = cost.paceReduction / pace;

  const delayMonths = fromSetAside + fromPace;

  return {
    before,
    after,
    delayMonths,
    // Rounded to whole days: a delay expressed to the hour would claim a
    // precision a monthly pace does not have.
    delayDays: Math.round(delayMonths * 30),
  };
}
