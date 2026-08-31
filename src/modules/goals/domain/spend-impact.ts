/**
 * What spending from a wallet costs the goals saving into it.
 *
 * The household is about to enter an outflow. Because an outflow outranks the
 * goals sharing its wallet, saving it will shrink the money those goals are
 * counted as holding. This is the figure that has to be shown BEFORE the event
 * is saved — a goal quietly losing 3tr because a bill was scheduled against its
 * wallet is precisely the kind of silent erosion the product exists to prevent.
 *
 * The arithmetic is a before/after of `resolveGoalCommittedAmount`, per goal,
 * around one lowered wallet value — deliberately not a second implementation of
 * the ordering rule. Whatever `resolveWalletShareByGoal` and `allocationValue`
 * do, this reports; the two can never drift into disagreeing about what a spend
 * costs, which is the only property that makes the warning trustworthy.
 *
 * The resulting order — this month's contribution first, then money already set
 * aside — is a consequence of that, not something imposed here. See
 * `walletValuesAfterOutflows` for why lowering the value is the whole rule.
 *
 * Pure: values and claims are passed in already resolved.
 */

import {
  resolveGoalCommittedPartsByGoal,
  type GoalWalletClaim,
} from './goal-progress';

export interface GoalSpendImpact {
  goalId: string;
  /** What the goal is counted as holding from this wallet before the spend. */
  before: number;
  /** …and after. Never negative. */
  after: number;
  /** How much this goal loses. Positive, or 0 when it is untouched. */
  reduction: number;
  /**
   * How much of `reduction` comes out of THIS MONTH'S CONTRIBUTION, and how
   * much out of money ALREADY SET ASIDE.
   *
   * Reported apart because they are different events for the household: a month
   * of saving paused, versus the goal moving backwards. The pace is always
   * squeezed out first, so a small spend touches only the first.
   */
  paceReduction: number;
  setAsideReduction: number;
}

export interface SpendImpactResult {
  assetId: string;
  assetValue: number;
  amount: number;
  /**
   * The wallet's value once the spend is taken out. NOT floored: a wallet may
   * hold a negative balance (see [[wallet-replay-on-edit]]), and this is the one
   * figure whose job is to warn what a spend costs — flooring it at 0 told a
   * household already 10tr overdrawn that spending 5tr more leaves them at 0đ,
   * hiding exactly the consequence the screen exists to show.
   */
  assetValueAfter: number;
  /** Total goal money lost across every goal on this wallet. */
  totalReduction: number;
  /** Across every goal — this month's contribution given up. */
  totalPaceReduction: number;
  /** Across every goal — money already set aside taken back out. */
  totalSetAsideReduction: number;
  /** Per-goal, only the goals that actually lose something. */
  goals: GoalSpendImpact[];
  /**
   * True when the wallet cannot cover the spend at all. The caller still shows
   * the goal impact — the household may well go ahead — but the shortfall is a
   * different sentence from "your goal shrinks".
   */
  exceedsWallet: boolean;
}

export function resolveSpendImpact(
  claims: GoalWalletClaim[],
  assetId: string,
  assetValue: number,
  amount: number,
  /**
   * What percent claims are a percentage OF, when `assetValue` has already been
   * lowered by outflows the household has scheduled but not yet paid.
   *
   * A percent claim records a decision made once — "90% of this wallet is the
   * car's" is how the form writes down 27tr on the day the goal was created. It
   * is NOT a ratio that re-derives itself every time the wallet moves. Passing
   * the lowered wallet as both value and basis re-read 90% against 26tr and
   * reported 23,4tr set aside, shaving the goal by 3,6tr that nobody spent.
   *
   * So the basis stays the wallet BEFORE the scheduled outflows, while
   * `assetValue` (the cap) carries them. The set-aside figure then holds and the
   * outflow comes out of free room first — this month's contribution — which is
   * the order the product wants and the household expects.
   *
   * Defaults to `assetValue`, which is right whenever nothing is scheduled.
   */
  percentBasisValue: number = assetValue,
): SpendImpactResult {
  const spend = Math.max(0, amount);
  // What the household is TOLD the wallet will hold — the true figure, negative
  // and all.
  const assetValueAfter = assetValue - spend;
  // What the goal resolvers are asked to work from. Floored at 0 because a claim
  // cannot be worth a negative amount: the resolvers already return 0 for a
  // non-positive wallet, so this only keeps the two sides measuring the same
  // thing rather than changing any claim.
  const resolvedValueAfter = Math.max(0, assetValueAfter);

  // Every goal resolved TOGETHER, twice — once at each wallet value.
  //
  // Resolving one goal at a time (`[claim]`) would measure each as if it were
  // alone on the wallet, so every goal would see the whole wallet as its own
  // free room and the per-goal figures would sum to more than the wallet holds.
  // Two goals on a 20tr wallet reported 15tr and 13tr — 28tr of money that does
  // not exist. The competition between goals for the same free room IS the rule
  // (`resolveWalletShareByGoal` orders by priority and splits by the declared
  // shares), and it only exists when they are resolved as a group.
  const basis = new Map([[assetId, percentBasisValue]]);
  const before = resolveGoalCommittedPartsByGoal(
    claims,
    new Map([[assetId, assetValue]]),
    basis,
  );
  // The percent basis stays the UNSPENT wallet on both sides: a spend must take
  // unassigned money first, not shave every percent claim proportionally while
  // free money is still sitting in the wallet. Paying 5tr out of a 52tr wallet
  // with 6tr unassigned reported "mục tiêu giảm 2,5tr" before this.
  const after = resolveGoalCommittedPartsByGoal(
    claims,
    new Map([[assetId, resolvedValueAfter]]),
    basis,
  );

  const goals: GoalSpendImpact[] = [];
  let totalReduction = 0;
  let totalPaceReduction = 0;
  let totalSetAsideReduction = 0;

  for (const claim of claims) {
    const beforeParts = before.get(claim.goalId) ?? { setAside: 0, pace: 0 };
    const afterParts = after.get(claim.goalId) ?? { setAside: 0, pace: 0 };

    const beforeValue = beforeParts.setAside + beforeParts.pace;
    const afterValue = afterParts.setAside + afterParts.pace;
    const reduction = Math.max(0, beforeValue - afterValue);
    if (reduction <= 0) {
      continue;
    }

    const paceReduction = Math.max(0, beforeParts.pace - afterParts.pace);
    const setAsideReduction = Math.max(
      0,
      beforeParts.setAside - afterParts.setAside,
    );

    totalReduction += reduction;
    totalPaceReduction += paceReduction;
    totalSetAsideReduction += setAsideReduction;
    goals.push({
      goalId: claim.goalId,
      before: beforeValue,
      after: afterValue,
      reduction,
      paceReduction,
      setAsideReduction,
    });
  }

  // Biggest loser first: the goal paying most for this spend is the one the
  // household needs to see without scanning.
  goals.sort((a, b) => b.reduction - a.reduction);

  return {
    assetId,
    assetValue,
    amount: spend,
    assetValueAfter,
    totalReduction,
    totalPaceReduction,
    totalSetAsideReduction,
    goals,
    exceedsWallet: spend > assetValue,
  };
}
