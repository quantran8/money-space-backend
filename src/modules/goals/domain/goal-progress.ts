/**
 * Goal progress (spec §20).
 *
 * Answers "how much money is actually behind this goal right now" — the one
 * number every goal surface shows, and the input `projectGoal` turns into a
 * date.
 *
 * A goal holds no money of its own. It is a set of SHARES of real assets, so
 * progress is summed from its allocations against LIVE asset values. Gold,
 * crypto, stocks and cash can each send a share to one goal, and "money set
 * aside from shared money" is simply a fixed share of a `cash`/`bank_account`
 * asset — that is where the money actually sits.
 *
 * Nothing is stored, so nothing can drift: the goal follows its assets as they
 * reprice or get spent, with no event to record and no mirror to keep. That is
 * also why spending needs no goal-side write at all.
 *
 * Pure: asset values are passed in already computed (`computeCurrentValue` runs
 * at the service layer, where market prices and FX rates live). Nothing here
 * reads the clock or the database.
 */

export type GoalAllocationKind = 'fixed' | 'percent';

/**
 * What a share is FOR. Both count towards progress; only `contribution` counts
 * towards the monthly pace — see `resolveContributionProgressAmount`.
 */
export type GoalAllocationRole = 'contribution' | 'holding';

export interface GoalAllocationInput {
  assetId: string;
  kind: GoalAllocationKind;
  /**
   * Defaults to `holding` when absent, so a caller that has not been taught
   * about roles cannot accidentally inflate the pace.
   */
  role?: GoalAllocationRole | null;
  /**
   * What this wallet is meant to put in each month. Only `contribution` shares
   * carry one; `resolvePlannedMonthlyContribution` sums them into the goal's
   * declared pace.
   */
  monthlyContribution?: number | null;
  /** Set when `kind = 'fixed'`. A declared VND amount. */
  allocatedAmount?: number | null;
  /** Set when `kind = 'percent'`. 0 < percent <= 100. */
  percent?: number | null;
}

/**
 * What one allocation is worth right now.
 *
 * A `fixed` claim is CAPPED at the asset's current value. The household
 * declared "50tr of my stocks belongs to the car" against a 100tr position; if
 * that position falls to 30tr, only 30tr is really there. Reporting the
 * declared 50tr would be the product inventing money — the exact failure this
 * whole change exists to remove. The cap is why a price fall needs no write
 * anywhere: the number corrects itself on read.
 *
 * A missing asset (deleted, or not in the value map) contributes 0 rather than
 * throwing: a goal whose asset went away is a goal at lower progress, not a
 * broken page.
 */
function allocationValue(
  allocation: GoalAllocationInput,
  assetValues: ReadonlyMap<string, number>,
): number {
  const assetValue = assetValues.get(allocation.assetId) ?? 0;
  if (assetValue <= 0) {
    return 0;
  }
  if (allocation.kind === 'percent') {
    const percent = allocation.percent ?? 0;
    if (percent <= 0) {
      return 0;
    }
    return (assetValue * Math.min(100, percent)) / 100;
  }
  const allocated = allocation.allocatedAmount ?? 0;
  if (allocated <= 0) {
    return 0;
  }
  return Math.min(allocated, assetValue);
}

/**
 * The goal's progress amount — the figure that feeds progress %, the
 * projection, and the dashboard's "already set aside" split.
 *
 * Never negative, and never more than the assets behind it actually hold. That
 * second property is structural, which is why the dashboard needs no cap of its
 * own: every allocation is bounded by its asset's live value, and no asset can
 * be over-allocated across goals (`GoalsService.assertWithinAssetValue`).
 */
export function resolveGoalProgressAmount(
  allocations: GoalAllocationInput[],
  assetValues: ReadonlyMap<string, number>,
): number {
  return allocations.reduce(
    (sum, allocation) => sum + allocationValue(allocation, assetValues),
    0,
  );
}

/**
 * The part of progress that came from money the household PUT IN, rather than
 * from value it already held.
 *
 * Same formula, restricted to `contribution` shares. That restriction is what
 * makes a monthly pace meaningful: a wallet has no market price, so its balance
 * moves only when money is taken in or spent, and a pace measured from wallets
 * needs no separating of price movement from principal — there is nothing to
 * separate. Measuring the full progress instead answered "did we keep our
 * 10tr-a-month?" with gold's price: a month nobody contributed to could read
 * "đủ nhịp" because gold rose, and a month they saved the full 10tr could read
 * "thiếu" because gold fell.
 *
 * A goal with no `contribution` share returns 0 — the caller distinguishes that
 * from "contributed nothing" (see `buildGoalMonthlyProgress`).
 */
export function resolveContributionProgressAmount(
  allocations: GoalAllocationInput[],
  assetValues: ReadonlyMap<string, number>,
): number {
  return allocations.reduce(
    (sum, allocation) =>
      allocation.role === 'contribution'
        ? sum + allocationValue(allocation, assetValues)
        : sum,
    0,
  );
}

/**
 * The goal's declared monthly pace — the sum of what its wallets say they put
 * in each month.
 *
 * The goal itself declares nothing. A pace typed on the goal named no account
 * the money would come out of, so it could be kept next to gold-only backing and
 * be measured, month after month, against wallet movement it had no relationship
 * to. Summing the wallets' own figures means the plan and the thing that has to
 * carry it out are the same rows.
 *
 * Returns `null` — not 0 — when no wallet declared an amount. That is "no pace
 * was planned", which the projection reads as "no completion date" and the pace
 * panel as "no target"; 0 would mean the household planned to save nothing and
 * would earn them a shortfall verdict every month.
 *
 * `holding` shares are ignored even if one somehow carries a figure: the pace is
 * measured on contribution shares alone, so counting a holding into the target
 * would report a shortfall for money that was never going to move.
 */
export function resolvePlannedMonthlyContribution(
  allocations: GoalAllocationInput[],
): number | null {
  let total = 0;
  let declared = false;
  for (const allocation of allocations) {
    if (allocation.role !== 'contribution') {
      continue;
    }
    const amount = allocation.monthlyContribution;
    if (amount == null || !Number.isFinite(amount) || amount < 0) {
      continue;
    }
    total += amount;
    declared = true;
  }
  return declared ? total : null;
}

/**
 * How much of `assetValue` is already claimed by allocations OTHER than the one
 * being written — the figure `GoalsService` compares a new/edited claim
 * against, so the household cannot promise the same money to two goals.
 *
 * Percent claims are resolved against the live value here too, so mixing "all
 * of my gold" with "50tr of my gold" is caught rather than silently allowed.
 *
 * Kept in this module (rather than the service) so the over-allocation rule and
 * the progress rule can never read an allocation differently.
 */
export function sumAllocatedAgainstAsset(
  allocations: GoalAllocationInput[],
  assetId: string,
  assetValue: number,
  excludeIndex?: number,
): number {
  const values = new Map<string, number>([[assetId, assetValue]]);
  return allocations.reduce((sum, allocation, index) => {
    if (index === excludeIndex || allocation.assetId !== assetId) {
      return sum;
    }
    return sum + allocationValue(allocation, values);
  }, 0);
}
