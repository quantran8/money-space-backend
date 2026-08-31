/**
 * Wallet values with this month's still-to-happen outflows taken out.
 *
 * Used to compute the **projected** layer that sits BESIDE a goal's actual
 * figures — never to replace them.
 *
 * ## The two-layer rule
 *
 * A pace or a set-aside amount is reported against the wallet AS IT STANDS, with
 * scheduled outflows still in it. Money that has not moved has not been spent:
 * a bill can still be cancelled or postponed, and stating it as already gone
 * would report as fact something that has not happened.
 *
 * What the outflows will cost is shown on its own line instead — "sau khoản chi
 * sắp tới: …". The household sees what is true now and what is coming, and
 * neither figure overwrites the other. The projected line is rendered ONLY where
 * it actually differs, so a wallet with no bill against it gains no second
 * number.
 *
 * (Contrast `walletValuesAfterOutflows` in forecast, which DOES lower the figure
 * it reports. That is right there: flexible money answers "what can I spend",
 * and money earmarked for a bill cannot be spent twice. A goal's pace answers
 * "what have we put in", which is a different question about a different moment.)
 *
 * ## Why lowering the value is the whole implementation
 *
 * Identical to `walletValuesAfterOutflows`, and deliberately so — the ordering
 * the product wants (this month's contribution gives way first, money already
 * set aside only after) falls out of a smaller wallet value, because the pace
 * is capped by free room (value − set aside) while `allocationValue` caps a
 * claim at the value itself. No separate draining logic, and no second place
 * for the two rules to drift apart.
 *
 * ## Scope
 *
 * Only outflows that are:
 *
 *  - **live** (`LIVE_CASHFLOW_STATUSES`) — a cancelled or completed event must
 *    not be subtracted. A completed one already moved the balance, so counting
 *    it here would charge it twice; `postponed` is excluded for the same reason
 *    the forecast excludes it, its date is no longer trusted.
 *  - **due within the window being reported** — a bill due in three months has
 *    not taken anything away from what is being saved now. `through` is the
 *    boundary, so the caller decides the window rather than this file assuming
 *    one. (It currently passes a rolling 30 days rather than the end of the
 *    calendar month: standing on the 31st, a month boundary hid a bill due
 *    tomorrow.)
 *  - **settling from a known wallet** — an outflow with no wallet, or one
 *    naming an asset absent from the map, cannot lower a value that was never
 *    counted.
 *
 * Incoming events are deliberately NOT added, matching the forecast: money that
 * has not arrived cannot already be behind a goal, and crediting it would let a
 * future salary inflate the month's contribution.
 *
 * Recurrence is NOT expanded. `expectedDate` is the current occurrence, so a
 * monthly series contributes at most one hit to a ~30-day window. A weekly or
 * daily cadence would genuinely land more than once in that span and is
 * therefore under-counted here; expanding occurrences is the fix, and it
 * belongs with the forecast's expander rather than in this file.
 *
 * Pure: no clock, no database.
 */

import {
  LIVE_CASHFLOW_STATUSES,
  type CashflowEvent,
} from '../../cashflow-events/entities/cashflow-event.entity';

export function walletValuesAfterPendingOutflows(
  assetValues: ReadonlyMap<string, number>,
  events: readonly CashflowEvent[],
  /** Inclusive ISO date bound — the last day of the month being reported. */
  through: string,
): Map<string, number> {
  const values = new Map(assetValues);

  for (const event of events) {
    if (
      event.direction !== 'outgoing' ||
      !event.settlementAssetId ||
      !LIVE_CASHFLOW_STATUSES.includes(event.status) ||
      event.expectedDate > through
    ) {
      continue;
    }
    const current = values.get(event.settlementAssetId);
    if (current === undefined) {
      // Settles from a wallet that is not in the map (deleted, or not an active
      // asset). It never backed the goal, so it cannot lower it here.
      continue;
    }
    // Floored at 0 for the same reason the forecast floors it: a wallet cannot
    // hold negative money, and letting it go negative would make one overdrawn
    // wallet cancel out another's goal backing.
    values.set(event.settlementAssetId, Math.max(0, current - event.amount));
  }

  return values;
}
