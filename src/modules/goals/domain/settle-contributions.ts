/**
 * Closing the month's books on a goal's contribution shares.
 *
 * `allocatedAmount` is a sub-ledger, not a figure typed once: the month-end job
 * rewrites it to what the share actually managed to hold. Read off the wallet
 * BALANCE at the close, never off a transaction — see memory/goals.md.
 *
 * Pure: no clock, no database, no currency rounding.
 */

import { PRIORITY_RANK, type GoalPriority } from './goal-progress';

/** One contribution share being closed. */
export interface SettlementAllocation {
  allocationId: string;
  goalId: string;
  assetId: string;
  /** Where this share's ledger stood at the start of the month. */
  allocatedAmount: number;
  /** What it meant to add. Null/0 means the household declared no pace. */
  monthlyContribution: number | null;
  /** 1–100; splits a tie at one priority. Null means never asked. */
  sharePercent: number | null;
  /** How this goal ranks against the others drawing on the same wallet. */
  priority: GoalPriority;
}

/** What one share ended the month with. */
export interface SettlementResult {
  allocationId: string;
  goalId: string;
  assetId: string;
  /** The ledger at the start of the month — `allocatedAmount` as it was. */
  opening: number;
  /** `opening + monthlyContribution`: what the share was reaching for. */
  target: number;
  /** The ledger now. What `allocatedAmount` is rewritten to. */
  closing: number;
  /** `closing - opening`. Negative when spending ate into the goal. */
  actual: number;
  /** Missed the target because the wallet ran out, not for want of a pace. */
  shortOnWallet: boolean;
  /** A tie was split by the fallback because no shares were declared. */
  needsShareDecision: boolean;
}

/**
 * Close one month for every share passed in.
 *
 * @param allocations  Every contribution share to settle, across all wallets.
 * @param closingBalances  Each wallet's balance at the close, by asset id.
 */
export function settleMonthlyContributions(
  allocations: SettlementAllocation[],
  closingBalances: ReadonlyMap<string, number>,
): SettlementResult[] {
  const results: SettlementResult[] = [];
  const walletIds = new Set(allocations.map((entry) => entry.assetId));

  for (const assetId of walletIds) {
    const inWallet = allocations.filter((entry) => entry.assetId === assetId);
    // Never negative: a wallet cannot owe its goals money.
    let remaining = Math.max(0, closingBalances.get(assetId) ?? 0);

    // Sorted by rank, not by the three names, so this stays in step with
    // `PRIORITY_RANK` — the one place the ordering lives.
    const byPriority = [
      ...new Set(inWallet.map((entry) => entry.priority)),
    ].sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b]);

    for (const priority of byPriority) {
      const group = inWallet.filter((entry) => entry.priority === priority);
      // A share with no declared pace still aims at what it already holds: it
      // was never released, so it keeps its place ahead of lower priorities.
      const aims = group.map((entry) => ({
        entry,
        opening: Math.max(0, entry.allocatedAmount),
        target: Math.max(
          0,
          entry.allocatedAmount + Math.max(0, entry.monthlyContribution ?? 0),
        ),
      }));
      const wanted = aims.reduce((sum, aim) => sum + aim.target, 0);

      if (wanted <= remaining) {
        // Covered in full, so no tie to break and the shares stay unused.
        for (const aim of aims) {
          results.push(toResult(aim, aim.target, false, false));
        }
        remaining -= wanted;
        continue;
      }

      // Short: split by declared shares only when EVERY member has one —
      // mixing them with fallback weights measures goals on different scales.
      const useShares = aims.every((aim) => aim.entry.sharePercent !== null);
      const weights = aims.map((aim) =>
        useShares ? (aim.entry.sharePercent ?? 0) : aim.target,
      );
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      const pool = remaining;

      // Two passes, matching `resolveWalletShareByGoal`: weighted portions
      // capped at each target, then the leftovers go round again so a goal
      // asking for less than its weight strands nothing.
      const portions = aims.map((aim, index) =>
        totalWeight > 0
          ? Math.min(aim.target, (pool * weights[index]) / totalWeight)
          : 0,
      );
      let leftover = pool - portions.reduce((sum, part) => sum + part, 0);
      if (leftover > 0) {
        for (let index = 0; index < aims.length && leftover > 0; index += 1) {
          const room = aims[index].target - portions[index];
          if (room <= 0) continue;
          const extra = Math.min(room, leftover);
          portions[index] += extra;
          leftover -= extra;
        }
      }

      for (const [index, aim] of aims.entries()) {
        results.push(toResult(aim, portions[index], true, !useShares));
      }
      remaining = Math.max(0, leftover);
    }
  }

  return results;
}

function toResult(
  aim: {
    entry: SettlementAllocation;
    opening: number;
    target: number;
  },
  closing: number,
  shortOnWallet: boolean,
  needsShareDecision: boolean,
): SettlementResult {
  return {
    allocationId: aim.entry.allocationId,
    goalId: aim.entry.goalId,
    assetId: aim.entry.assetId,
    opening: aim.opening,
    target: aim.target,
    closing,
    actual: closing - aim.opening,
    // Only meaningful when the share fell short: reaching the target inside a
    // squeezed group is not being held back.
    shortOnWallet: shortOnWallet && closing < aim.target,
    needsShareDecision: needsShareDecision && closing < aim.target,
  };
}
