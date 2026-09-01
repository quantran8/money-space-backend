/**
 * What a spend leaves for the outflows scheduled AFTER it.
 *
 * The spend preview answers "what does this cost my goals". It cannot answer
 * "will the bills after it still be paid", because the window that feeds it
 * stops at the spend's own date — a later bill must not reach back and squeeze
 * an earlier spend. That bound is right, but it left the opposite question with
 * nowhere to live: emptying a wallet on the 31st said nothing about the 4tr due
 * on the 1st, and the household saw no warning at all.
 *
 * So this walks FORWARD instead. Starting from what the wallet holds once the
 * spend is taken out, each later outflow is subtracted in date order and the
 * balance after it recorded. Any row that lands below zero is money the
 * household has promised twice.
 *
 * Incoming events ARE counted here, unlike everywhere else in this folder. The
 * question is "will this bill be payable", and a salary landing before it is
 * exactly what makes it payable. (A goal's progress asks a different question —
 * money that has not arrived cannot already be behind a goal — which is why
 * `wallet-values-after-pending` deliberately ignores them.)
 *
 * Pure: no clock, no database.
 */

import {
  LIVE_CASHFLOW_STATUSES,
  type CashflowEvent,
} from '../../cashflow-events/entities/cashflow-event.entity';

export interface SpendAftermathRow {
  eventId: string;
  name: string;
  /** Signed: negative for an outflow, positive for money arriving. */
  amount: number;
  expectedDate: string;
  /** What the wallet holds once this event has happened. */
  balanceAfter: number;
  /** True when `balanceAfter` is below zero — this event cannot be paid. */
  short: boolean;
}

export interface SpendAftermath {
  /** The wallet immediately after the spend, before any later event. */
  openingBalance: number;
  rows: SpendAftermathRow[];
  /** How many rows land below zero. */
  shortfallCount: number;
  /** The lowest balance reached, so the caller can state the worst point. */
  lowestBalance: number;
}

export function resolveSpendAftermath(
  events: readonly CashflowEvent[],
  assetId: string,
  /** The wallet once the spend being entered is taken out. May be negative. */
  balanceAfterSpend: number,
  /** The spend's own date. Only events strictly after it are walked. */
  afterDate: string,
  /** Inclusive far bound, so the walk does not run to the end of time. */
  through: string,
  /** The event being edited, which the typed amount replaces. */
  excludeEventId?: string,
): SpendAftermath {
  const relevant = events
    .filter(
      (event) =>
        event.settlementAssetId === assetId &&
        event.id !== excludeEventId &&
        LIVE_CASHFLOW_STATUSES.includes(event.status) &&
        event.expectedDate > afterDate &&
        event.expectedDate <= through,
    )
    // Date order is what makes a running balance mean anything. Ties are broken
    // by id so the same set always walks the same way.
    .sort(
      (a, b) =>
        a.expectedDate.localeCompare(b.expectedDate) || a.id.localeCompare(b.id),
    );

  let running = balanceAfterSpend;
  let lowestBalance = balanceAfterSpend;
  const rows: SpendAftermathRow[] = [];

  for (const event of relevant) {
    const signed =
      event.direction === 'incoming' ? event.amount : -event.amount;
    running += signed;
    lowestBalance = Math.min(lowestBalance, running);
    rows.push({
      eventId: event.id,
      name: event.name,
      amount: signed,
      expectedDate: event.expectedDate,
      balanceAfter: running,
      short: running < 0,
    });
  }

  return {
    openingBalance: balanceAfterSpend,
    rows,
    shortfallCount: rows.filter((row) => row.short).length,
    lowestBalance,
  };
}
