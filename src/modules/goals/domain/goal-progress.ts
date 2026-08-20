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
  /**
   * This goal's share (1–100) of the wallet's remaining monthly room, consulted
   * only to split a shortfall between goals tied at the same priority. Null
   * means the household was never asked — see `resolveWalletShareByGoal`.
   */
  sharePercent?: number | null;
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
  /**
   * What the percent is a percentage OF, when that differs from the wallet's
   * current value.
   *
   * Spending from a wallet must not shrink a percent claim while unpromised
   * money is still sitting in it. "50% of this wallet" describes a standing
   * arrangement, not a figure that re-derives itself every time a bill is
   * scheduled: paying 5tr out of a 52tr wallet with 6tr unassigned should cost
   * the goals nothing, but re-reading the percent against 47tr quietly shaved
   * 2,5tr off them.
   *
   * So callers that lower a wallet (see `walletValuesAfterOutflows`) pass the
   * ORIGINAL value here. The claim is still capped at what the wallet actually
   * holds afterwards — a percent cannot conjure money that is gone — which is
   * what makes a genuinely unaffordable spend still reduce the goals.
   */
  percentBasis?: ReadonlyMap<string, number>,
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
    const basis = percentBasis?.get(allocation.assetId) ?? assetValue;
    // Capped at the wallet's live value for the same reason a fixed claim is:
    // reporting more than is there would be the product inventing money.
    return Math.min(
      (basis * Math.min(100, percent)) / 100,
      assetValue,
    );
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

/** How goals are ordered when one wallet cannot feed them all. */
export type GoalPriority = 'high' | 'medium' | 'low';

/** One goal competing for the wallets it draws on. */
export interface GoalWalletClaim {
  goalId: string;
  priority: GoalPriority;
  allocations: GoalAllocationInput[];
}

/** What one goal ended up with, and whether the household still owes a decision. */
export interface GoalWalletShare {
  /** VND this goal can still put in this month across all its wallets. */
  amount: number;
  /**
   * True when a tie had to be split without the household having said how — no
   * `sharePercent` on the competing shares. The figure is a fallback (split in
   * proportion to the declared paces), so the UI can ask rather than present it
   * as settled.
   */
  needsShareDecision: boolean;
}

/** Highest priority first — the order a wallet is drained in. */
const PRIORITY_ORDER: GoalPriority[] = ['high', 'medium', 'low'];

/**
 * How the household's own ranking sorts — lower number = more important.
 *
 * Exported so every "which goal gives way first" decision reads the ranking the
 * same way. A second copy of this ordering somewhere else is how `medium` ends
 * up outranking `high` in one screen and not another.
 */
export const PRIORITY_RANK: Record<GoalPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** What one wallet's goals claim of it, and how important the top one is. */
export interface WalletGoalClaim {
  /** VND the goals claim of this wallet, capped at what it holds. */
  amount: number;
  /** The most important goal it backs; null when it backs none. */
  topPriority: GoalPriority | null;
}

/**
 * How much of each wallet every goal can still put in this month.
 *
 * The running month has no close to be measured against, so instead of a blank
 * the panel estimates what the household is on track to manage. One wallet can
 * back several goals, and they COMPETE: an account with 2tr free cannot give
 * 2tr to each of two goals, so the estimate has to be computed for all of them
 * at once rather than one goal at a time.
 *
 * Per wallet:
 *
 *  1. Free room = walletValue - everything already set aside against it, by
 *     every goal (`sumAllocatedAgainstAsset` — the same rule the write path
 *     enforces, so one đồng is never promised twice).
 *  2. Goals are served by `priority`: `high`, then `medium`, then `low`. A high
 *     goal takes its full declared pace before a medium one gets anything.
 *  3. Within one priority — the tie `priority` cannot break — if the room covers
 *     every pace in the group, each takes its pace in full and `sharePercent` is
 *     not consulted at all. Only when the group is SHORT is the room split, by
 *     the shares the household declared.
 *  4. Each goal is still capped at its own declared pace, and whatever a cap
 *     leaves behind flows on to the next priority group rather than evaporating.
 *
 * The totals therefore can never exceed what the wallet actually holds free,
 * which is the property the per-goal version could not offer.
 *
 * Fallback: shares split in proportion to the declared paces when the competing
 * allocations carry no `sharePercent`. Goals created before the column existed
 * have none, and so does a pair the household made same-priority AFTER creating
 * them. Splitting evenly by pace is even-handed rather than arbitrary, and the
 * `needsShareDecision` flag lets the UI ask instead of pretending it was chosen.
 *
 * This is an ESTIMATE of capacity, not money observed moving. It is only ever
 * used for the month still running, and only when there is no real close to
 * compute a delta from.
 *
 * Pure: no clock, no database. Wallet values are passed in already resolved.
 */
export function resolveWalletShareByGoal(
  claims: GoalWalletClaim[],
  assetValues: ReadonlyMap<string, number>,
  /**
   * What percent claims are a percentage OF. Must match what the set-aside half
   * used, or free room is measured against a different set-aside figure than the
   * one actually reported — and the two halves stop adding up.
   */
  percentBasis?: ReadonlyMap<string, number>,
): Map<string, GoalWalletShare> {
  const result = new Map<string, GoalWalletShare>();
  for (const claim of claims) {
    result.set(claim.goalId, { amount: 0, needsShareDecision: false });
  }

  // Every allocation in play, so free room is measured against ALL claims on the
  // wallet, not just those of the goals being served.
  const everyAllocation = claims.flatMap((claim) => claim.allocations);
  const walletIds = new Set(
    everyAllocation
      .filter((allocation) => allocation.role === 'contribution')
      .map((allocation) => allocation.assetId),
  );

  for (const assetId of walletIds) {
    const walletValue = assetValues.get(assetId) ?? 0;
    let remaining = Math.max(
      0,
      walletValue -
        sumAllocatedAgainstAsset(
          everyAllocation,
          assetId,
          walletValue,
          undefined,
          percentBasis,
        ),
    );

    for (const priority of PRIORITY_ORDER) {
      if (remaining <= 0) {
        break;
      }
      // What each goal at this priority wants out of THIS wallet.
      const group = claims
        .filter((claim) => claim.priority === priority)
        .map((claim) => ({
          goalId: claim.goalId,
          pace: paceForWallet(claim.allocations, assetId),
          share: shareForWallet(claim.allocations, assetId),
        }))
        .filter((entry) => entry.pace > 0);
      if (group.length === 0) {
        continue;
      }

      const wanted = group.reduce((sum, entry) => sum + entry.pace, 0);
      if (wanted <= remaining) {
        // The wallet covers everyone here. No tie to break, so the declared
        // shares stay unused — they exist for shortfalls, not for ordinary
        // months.
        for (const entry of group) {
          award(result, entry.goalId, entry.pace, false);
        }
        remaining -= wanted;
        continue;
      }

      // Short: the group has to divide what is left.
      const declared = group.filter((entry) => entry.share !== null);
      // Split by the household's shares when they gave any, otherwise by the
      // paces themselves. Mixing the two would let a goal with no share be
      // measured on a different scale from one with a share, so it is all or
      // nothing per group.
      const useShares = declared.length === group.length;
      const weights = group.map((entry) =>
        useShares ? (entry.share ?? 0) : entry.pace,
      );
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

      let pool = remaining;
      if (totalWeight > 0) {
        // Two passes: hand out weighted portions capped at each pace, then let
        // the leftovers from those caps go round again. Without the second pass
        // a goal asking for less than its share would strand money the group
        // could still use.
        const portions = group.map((entry, index) =>
          Math.min(entry.pace, (pool * weights[index]) / totalWeight),
        );
        let handed = 0;
        for (const [index, entry] of group.entries()) {
          award(result, entry.goalId, portions[index], !useShares);
          handed += portions[index];
        }
        pool -= handed;
        if (pool > 0) {
          for (const [index, entry] of group.entries()) {
            if (pool <= 0) {
              break;
            }
            const room = entry.pace - portions[index];
            const extra = Math.min(room, pool);
            if (extra > 0) {
              award(result, entry.goalId, extra, !useShares);
              pool -= extra;
            }
          }
        }
      }
      remaining = Math.max(0, pool);
    }
  }

  return result;
}

/** Add to a goal's running total, remembering if any part of it was a fallback. */
function award(
  result: Map<string, GoalWalletShare>,
  goalId: string,
  amount: number,
  fallback: boolean,
): void {
  const current = result.get(goalId);
  if (!current || amount <= 0) {
    return;
  }
  current.amount += amount;
  current.needsShareDecision = current.needsShareDecision || fallback;
}

/** What one goal declared it puts into a given wallet each month. */
function paceForWallet(
  allocations: GoalAllocationInput[],
  assetId: string,
): number {
  return allocations.reduce((sum, allocation) => {
    if (
      allocation.assetId !== assetId ||
      allocation.role !== 'contribution' ||
      allocation.monthlyContribution == null ||
      allocation.monthlyContribution <= 0
    ) {
      return sum;
    }
    return sum + allocation.monthlyContribution;
  }, 0);
}

/** The share this goal declared of a given wallet, or null if it declared none. */
function shareForWallet(
  allocations: GoalAllocationInput[],
  assetId: string,
): number | null {
  for (const allocation of allocations) {
    if (
      allocation.assetId === assetId &&
      allocation.role === 'contribution' &&
      allocation.sharePercent != null &&
      allocation.sharePercent > 0
    ) {
      return allocation.sharePercent;
    }
  }
  return null;
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
  /** See `allocationValue`. Defaults to `assetValue` when omitted. */
  percentBasis?: ReadonlyMap<string, number>,
): number {
  const values = new Map<string, number>([[assetId, assetValue]]);
  return allocations.reduce((sum, allocation, index) => {
    if (index === excludeIndex || allocation.assetId !== assetId) {
      return sum;
    }
    return sum + allocationValue(allocation, values, percentBasis);
  }, 0);
}

/**
 * How much of the household's liquid money is already spoken for by its goals.
 *
 * The dashboard's "đã có nhiệm vụ" used to mean near-term obligations alone, so
 * money the household had explicitly promised to a goal still sat in the
 * flexible half. Reading "22tr linh hoạt" when 20tr of it belongs to the car is
 * exactly the overstatement the product exists to prevent.
 *
 * Two parts, and they must not double-count:
 *
 *  1. **Already set aside** — every allocation's resolved worth. This money is
 *     in the wallet but promised.
 *  2. **This month's contribution** — the pace, but ONLY the part that can come
 *     out of what is still FREE. A wallet holding 28.8tr with 20tr already set
 *     aside can feed a 20tr pace by at most 8.8tr; the other 11.2tr of that pace
 *     would have to come from the 20tr already counted in (1).
 *
 * `resolveWalletShareByGoal` already computes exactly that second part — free
 * room only, ordered by priority, split by the declared shares — so the two
 * halves compose without overlapping by construction.
 *
 * Only assets the caller passes in are counted, so the caller decides the
 * liquidity filter: gold backing a goal is not part of "liquid money already
 * committed" because it was never in the liquid total to begin with.
 *
 * Pure: values and claims are passed in already resolved.
 */
/**
 * The same figure as `resolveGoalCommittedAmount`, but broken down PER GOAL.
 *
 * Needed wherever the answer has to name which goal an amount belongs to — the
 * spend-impact warning, which says "car giảm 3tr" rather than handing the
 * household a total to attribute themselves.
 *
 * Callers must not approximate this by calling `resolveGoalCommittedAmount`
 * once per goal with a single-element array: each goal would then see the whole
 * wallet as its own free room, and the per-goal figures would sum to more than
 * the wallet holds. The competition between goals for the same room is the rule
 * (`resolveWalletShareByGoal`), and it only exists when they are resolved as a
 * group.
 */
export interface GoalCommittedParts {
  /** Money already sitting behind the goal. */
  setAside: number;
  /** What this month's pace can still draw from the room left over. */
  pace: number;
}

/**
 * The same breakdown, with the two halves kept APART.
 *
 * Callers that only need the figure use `resolveGoalCommittedAmountByGoal`.
 * This one exists for the ones that must say WHICH half moved — the spend
 * warning, where "this month's saving drops by 2tr" and "another 3tr comes out
 * of what was set aside" are different events for the household: a month of
 * saving paused, versus the goal moving backwards. A single total cannot tell
 * them apart.
 */
export function resolveGoalCommittedPartsByGoal(
  claims: GoalWalletClaim[],
  assetValues: ReadonlyMap<string, number>,
  /**
   * What percent claims are a percentage OF, when the caller has lowered the
   * wallets (e.g. by an outflow). Omit when `assetValues` IS the basis.
   * See `allocationValue`.
   */
  percentBasis?: ReadonlyMap<string, number>,
): Map<string, GoalCommittedParts> {
  const result = new Map<string, GoalCommittedParts>();

  // (1) Everything already sitting behind each goal.
  for (const claim of claims) {
    const setAside = claim.allocations.reduce(
      (inner, allocation) =>
        assetValues.has(allocation.assetId)
          ? inner + allocationValue(allocation, assetValues, percentBasis)
          : inner,
      0,
    );
    result.set(claim.goalId, { setAside, pace: 0 });
  }

  // (2) What this month's pace can still draw from the room that is left —
  // resolved across ALL goals at once, so priority and the declared shares
  // decide who gets what.
  const shares = resolveWalletShareByGoal(claims, assetValues, percentBasis);
  for (const [goalId, share] of shares) {
    const current = result.get(goalId) ?? { setAside: 0, pace: 0 };
    current.pace += share.amount;
    result.set(goalId, current);
  }

  return result;
}

export function resolveGoalCommittedAmountByGoal(
  claims: GoalWalletClaim[],
  assetValues: ReadonlyMap<string, number>,
  percentBasis?: ReadonlyMap<string, number>,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const [goalId, parts] of resolveGoalCommittedPartsByGoal(
    claims,
    assetValues,
    percentBasis,
  )) {
    result.set(goalId, parts.setAside + parts.pace);
  }
  return result;
}

export function resolveGoalCommittedAmount(
  claims: GoalWalletClaim[],
  assetValues: ReadonlyMap<string, number>,
  percentBasis?: ReadonlyMap<string, number>,
): number {
  // (1) Everything already sitting behind a goal, across every allocation on the
  // assets the caller included.
  const setAside = claims.reduce(
    (sum, claim) =>
      sum +
      claim.allocations.reduce(
        (inner, allocation) =>
          assetValues.has(allocation.assetId)
            ? inner + allocationValue(allocation, assetValues)
            : inner,
        0,
      ),
    0,
  );

  // (2) What this month's pace can still draw from the room that is left.
  const shares = resolveWalletShareByGoal(claims, assetValues, percentBasis);
  const thisMonth = [...shares.values()].reduce(
    (sum, share) => sum + share.amount,
    0,
  );

  return setAside + thisMonth;
}
