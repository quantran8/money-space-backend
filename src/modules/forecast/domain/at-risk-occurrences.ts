/**
 * Which upcoming items the balance cannot cover, and by how much.
 *
 * `obligationsCovered` answers "is anything short?" with a yes or no. That is
 * enough to colour a badge and useless for deciding anything: the household
 * cannot act on "something in the next 30 days will not be covered" without
 * knowing WHICH thing and WHEN. What-if in particular exists to answer "what
 * happens if I spend this", and "one of your bills stops being payable" is only
 * an answer once it names the bill.
 *
 * The walk mirrors the forecast's own obligation pass exactly — confirmed
 * incoming, `required` outgoing, in timeline order — so this can never disagree
 * with `obligationsCovered` about whether there is a problem. It only says more
 * about it.
 *
 * `planned` outflows are never REPORTED as at risk, for the same reason the
 * coverage pass excludes them: discretionary plans running the balance low is
 * not an obligation going unmet, and listing them would cry wolf about spending
 * the household chose and can still unchoose.
 *
 * They do, however, still SPEND the money — a planned purchase that empties the
 * account leaves the rent just as unpayable as a required one would. So they are
 * subtracted from the running balance while being excluded from the results.
 * That asymmetry is the whole point of what-if: the hypothetical spend is
 * `planned` by construction, and if it did not move the balance here the feature
 * could never answer "what does this break?".
 *
 * Pure: no clock, no database.
 */

import type { ForecastResult } from './forecast.types';

export interface AtRiskOccurrence {
  occurrenceKey: string;
  sourceEventId: string;
  name: string;
  date: string;
  amount: number;
  /**
   * What the balance is when this item comes due — negative, because that is
   * what put it at risk.
   */
  balanceAfter: number;
  /**
   * How much is missing for THIS item: the whole amount when nothing is left,
   * or the part that is uncovered when the balance runs out partway.
   */
  shortfall: number;
}

export function findAtRiskOccurrences(
  forecast: ForecastResult,
): AtRiskOccurrence[] {
  const atRisk: AtRiskOccurrence[] = [];
  let balance = forecast.startingLiquidBalance;

  for (const occurrence of forecast.timeline) {
    if (!occurrence.countedInBalance) {
      continue;
    }

    if (occurrence.direction === 'incoming') {
      balance += occurrence.amount;
      continue;
    }

    const balanceBefore = balance;
    balance -= occurrence.amount;

    // Planned spending moves the balance but is never itself reported: it is a
    // choice, not an unmet obligation.
    if (occurrence.requirement !== 'required') {
      continue;
    }

    if (balance >= 0) {
      continue;
    }

    atRisk.push({
      occurrenceKey: occurrence.occurrenceKey,
      sourceEventId: occurrence.sourceEventId,
      name: occurrence.name,
      date: occurrence.date,
      amount: occurrence.amount,
      balanceAfter: balance,
      // Once the balance is already below zero, every later item is short by
      // its full amount — there is nothing left to put towards it.
      shortfall:
        balanceBefore > 0
          ? occurrence.amount - balanceBefore
          : occurrence.amount,
    });
  }

  return atRisk;
}

/**
 * The items that are at risk AFTER a spend but were not before it.
 *
 * The honest attribution: a bill that was already going unpaid is not this
 * purchase's doing, and listing it here would blame a spend for a problem it
 * did not create. Only the difference belongs to the decision being weighed.
 */
export function findNewlyAtRisk(
  before: ForecastResult,
  after: ForecastResult,
): AtRiskOccurrence[] {
  const alreadyAtRisk = new Set(
    findAtRiskOccurrences(before).map((item) => item.occurrenceKey),
  );
  return findAtRiskOccurrences(after).filter(
    (item) => !alreadyAtRisk.has(item.occurrenceKey),
  );
}
