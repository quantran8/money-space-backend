/**
 * Spend a single amount across the household's wallets, one after another.
 *
 * What-if asks a household-level question — "what if we spent this" — and names
 * no wallet, so the money has to come from somewhere the household would
 * plausibly take it from. Draining one wallet fully before touching the next
 * mirrors what actually happens: people pay from an account until it runs out,
 * not by splitting a purchase proportionally across every account they own.
 *
 * ## The order, and why it is not arbitrary
 *
 * Two passes, because "spend the free money first" cuts across wallets:
 *
 *  1. **Genuinely free money, everywhere.** Every wallet gives up the part no
 *     goal has claimed — across ALL wallets — before any goal is touched
 *     anywhere. A household with 2tr unassigned in one account and 3tr in
 *     another spends those 5tr first; making a goal give way while 5tr sat
 *     unpromised would be the simulation inventing a sacrifice.
 *  2. **Then goal money, by the household's own ranking.** Only once nothing is
 *     free does a goal give way, and the wallet backing the LEAST important goal
 *     goes first: `low` before `medium` before `high`. Amount breaks ties within
 *     a rank (fewest goal đồng first), so the damage reported is the smallest
 *     the household could plausibly incur.
 *
 *     Priority outranks amount, and that order matters: 1tr promised to the
 *     emergency fund is not more expendable than 50tr towards a someday holiday
 *     just because it is a smaller number. The household ranked their goals, and
 *     a simulation that spent the important one first would be answering a
 *     question they did not ask.
 *
 * The household has not said which account they would use, so the simulation
 * must pick; this order is both what most people actually do and the one that
 * does not overstate the cost. What-if exists to inform a decision, not to
 * argue against one.
 *
 * Ties break on the wallet id so the same question always gets the same answer:
 * a figure that moves between two identical runs is not one anybody can act on.
 *
 * ## What it does NOT do
 *
 * It does not decide whether the spend is affordable — that is the forecast's
 * job, and a spend larger than every wallet combined simply empties them all
 * here. The leftover is reported so the caller can say so plainly.
 *
 * Pure: no clock, no database.
 */

import {
  PRIORITY_RANK,
  type WalletGoalClaim,
} from '../../goals/domain/goal-progress';

export interface WalletDrain {
  /** Wallet values after the spend has been taken out, in draining order. */
  values: Map<string, number>;
  /** What could not be taken from any wallet. 0 when the spend fits. */
  uncovered: number;
}

export function spreadAcrossWallets(
  values: ReadonlyMap<string, number>,
  /** What each wallet's goals already claim of it, and their top priority. */
  goalClaims: ReadonlyMap<string, WalletGoalClaim>,
  amount: number,
): WalletDrain {
  const result = new Map(values);
  let remaining = Math.max(0, amount);

  const claimOf = (assetId: string) => goalClaims.get(assetId)?.amount ?? 0;

  /**
   * A wallet backing no goal ranks after every priority, so it is never sorted
   * ahead of one — pass 1 has already taken its free money, and by pass 2 it has
   * nothing left that needs ordering.
   */
  const rankOf = (assetId: string) => {
    const priority = goalClaims.get(assetId)?.topPriority ?? null;
    return priority === null
      ? Number.MAX_SAFE_INTEGER
      : PRIORITY_RANK[priority];
  };

  const order = [...values.keys()]
    .filter((assetId) => (values.get(assetId) ?? 0) > 0)
    .sort((left, right) => {
      // Least important goal first: `low` gives way before `high`.
      const byPriority = rankOf(right) - rankOf(left);
      if (byPriority !== 0) return byPriority;
      // Within one rank, the wallet promising least goes first.
      const byClaim = claimOf(left) - claimOf(right);
      // Deterministic tie-break: the same question must always get the same
      // answer, and wallet ids are the only stable key available here.
      return byClaim !== 0 ? byClaim : left.localeCompare(right);
    });

  const take = (assetId: string, available: number) => {
    const taken = Math.min(available, remaining);
    result.set(assetId, (result.get(assetId) ?? 0) - taken);
    remaining -= taken;
  };

  // Pass 1 — unpromised money in EVERY wallet, before any goal gives way
  // anywhere. Spending a goal's money while another account still holds free
  // cash would report a sacrifice the household would not actually make.
  for (const assetId of order) {
    if (remaining <= 0) break;
    const value = values.get(assetId) ?? 0;
    const free = Math.max(0, value - claimOf(assetId));
    if (free > 0) take(assetId, free);
  }

  // Pass 2 — goal money, least important goal first.
  for (const assetId of order) {
    if (remaining <= 0) break;
    take(assetId, result.get(assetId) ?? 0);
  }

  return { values: result, uncovered: remaining };
}
