/**
 * Wallet values with the horizon's outflows already taken out.
 *
 * The map goal commitments must be measured against — NOT today's balances.
 *
 * ## Why this exists
 *
 * An outflow ranks ABOVE the goals sharing its wallet. Money leaving the
 * household is an obligation; money behind a goal is a promise the household
 * makes to itself, and a promise yields to a bill. So when 5tr leaves the wallet
 * the car goal is saving into, the honest reading is "the car goal now holds
 * 5tr less" — not "the household is 5tr in the hole".
 *
 * Before this, `goalCommitments` was computed against `forecast.liquidSources`,
 * i.e. today's untouched balances, while `lowestProjectedBalance` had already
 * walked the timeline and subtracted those same outflows. Subtracting one from
 * the other charged every outflow TWICE, and the hero reported money the
 * household had not actually over-committed. A wallet holding 22tr entirely
 * behind a goal, plus one 2tr bill, read "−2tr linh hoạt" when the truth was
 * "0 free, and the goal absorbs the bill".
 *
 * ## Why lowering the value is the whole implementation
 *
 * The subtraction order the product wants — this month's contribution first,
 * then money already set aside — falls out of lowering the wallet value; no
 * separate draining logic is needed, and that is the point. Both halves of
 * `resolveGoalCommittedAmount` already read the wallet's value:
 *
 *  - The monthly pace is capped by FREE ROOM (value − already set aside), so a
 *    smaller value shrinks the free room first. The pace is what goes first.
 *  - `allocationValue` caps a fixed claim at the wallet's value, so once free
 *    room is gone, a smaller value eats into what was set aside.
 *
 * Worked through, for a 22tr wallet with 20tr set aside and a 20tr/month pace
 * (of which only 2tr fits this month):
 *
 * | outflow | pace | set aside | goal claim |
 * |---------|------|-----------|------------|
 * | 0       | 2tr  | 20tr      | 22tr       |
 * | 2tr     | 0    | 20tr      | 20tr       |
 * | 5tr     | 0    | 17tr      | 17tr       |
 *
 * ## Scope
 *
 * Only outflows COUNTED IN THE BALANCE are subtracted, so this map and the
 * forecast's own balances always agree about what is leaving. An occurrence the
 * forecast chose not to bank (a postponed bill, a `planned` outflow when those
 * are excluded) must not quietly drain a goal either.
 *
 * Incoming events are deliberately NOT added. Money that has not arrived cannot
 * already be behind a goal, and crediting it here would let a future salary
 * inflate today's goal progress.
 *
 * Pure: no clock, no database.
 */

import type { ForecastResult } from './forecast.types';

export function walletValuesAfterOutflows(
  forecast: ForecastResult,
): Map<string, number> {
  const values = new Map(
    forecast.liquidSources.map((source) => [source.assetId, source.value]),
  );

  for (const occurrence of forecast.timeline) {
    if (
      occurrence.direction !== 'outgoing' ||
      !occurrence.countedInBalance ||
      !occurrence.settlementAssetId
    ) {
      continue;
    }
    const current = values.get(occurrence.settlementAssetId);
    if (current === undefined) {
      // An outflow settling from a wallet the forecast did not count as liquid
      // (gold, a long-term account). It never contributed to the liquid total,
      // so it cannot reduce it here either.
      continue;
    }
    // Floored at 0: a wallet cannot hold negative money, and letting it go
    // negative would make one overdrawn wallet cancel out another's goal
    // backing.
    values.set(
      occurrence.settlementAssetId,
      Math.max(0, current - occurrence.amount),
    );
  }

  return values;
}
