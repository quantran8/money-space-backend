/**
 * Flexible money (spec §26B, 05 §3).
 *
 * "After everything already has a job, how much is actually free?" — the number
 * the Home screen leads with.
 *
 * Two hard rules, both easy to get wrong:
 *
 * 1. **It may be NEGATIVE, and that is the signal.** Negative means the
 *    household has already committed more than it holds. Clamping it to zero
 *    would hide exactly the situation the product exists to surface. Do not add
 *    `Math.max(0, …)` here.
 * 2. **It is never a spending allowance.** The product must never label this
 *    "what you can spend" (design §12.3) — it is what remains unassigned.
 */

import type { IsoDate } from '../../../common/utils/clock';
import type {
  CalculationAssumption,
  ForecastResult,
} from './forecast.types';

export interface FlexibleMoneyResult {
  asOfDate: IsoDate;
  horizonDays: number;
  currentSharedLiquidMoney: number;
  protectedReserveAmount: number;

  /** §26B conservative form. MAY BE NEGATIVE. */
  flexibleMoneyToday: number;
  requiredOutflowsBeforeNextInflow: number;
  nextSufficientlyCertainInflow: { date: IsoDate; amount: number } | null;
  /** The occurrence keys behind the subtraction, for "how was this computed". */
  consideredOutflowKeys: string[];

  /**
   * "Spendable without breaching the reserve at ANY point in the horizon."
   * This is the number what-if compares before/after. MAY BE NEGATIVE.
   */
  flexibleMoneyHorizon: number;
  /** End-of-horizon variant; must be labelled with its assumption when shown. */
  flexibleMoneyEndOfHorizon: number;

  lowestProjectedBalance: number;
  lowestProjectedBalanceDate: IsoDate;
  obligationsCovered: boolean;
  reserveProtected: boolean;
  assumptions: CalculationAssumption[];
}

export function computeFlexibleMoney(
  forecast: ForecastResult,
): FlexibleMoneyResult {
  const nextInflow = forecast.nextSufficientlyCertainInflow;

  // The window for "what must I pay before more money arrives".
  //
  // Inclusive of the inflow date: we don't know whether the salary lands before
  // or after that day's rent, and assuming the favourable order would overstate
  // what's free. Same conservative reasoning as the forecast's same-day
  // ordering.
  const windowEnd = nextInflow?.date ?? forecast.horizonEndDate;

  const consideredOutflows = forecast.timeline.filter(
    (occurrence) =>
      occurrence.direction === 'outgoing' &&
      occurrence.requirement === 'required' &&
      occurrence.countedInBalance &&
      occurrence.date <= windowEnd,
  );

  const requiredOutflowsBeforeNextInflow = consideredOutflows.reduce(
    (sum, occurrence) => sum + occurrence.amount,
    0,
  );

  const flexibleMoneyToday =
    forecast.startingLiquidBalance -
    forecast.protectedReserveAmount -
    requiredOutflowsBeforeNextInflow;

  // The horizon form answers "can I spend this without ever breaking the
  // reserve", which is what a decision actually needs.
  const flexibleMoneyHorizon =
    forecast.lowestProjectedBalance - forecast.protectedReserveAmount;

  const flexibleMoneyEndOfHorizon =
    forecast.endingProjectedBalance - forecast.protectedReserveAmount;

  return {
    asOfDate: forecast.asOfDate,
    horizonDays: forecast.horizonDays,
    currentSharedLiquidMoney: forecast.startingLiquidBalance,
    protectedReserveAmount: forecast.protectedReserveAmount,

    // Deliberately NOT clamped at zero — negative is the signal.
    flexibleMoneyToday: Math.round(flexibleMoneyToday),
    requiredOutflowsBeforeNextInflow: Math.round(
      requiredOutflowsBeforeNextInflow,
    ),
    nextSufficientlyCertainInflow: nextInflow
      ? { date: nextInflow.date, amount: nextInflow.amount }
      : null,
    consideredOutflowKeys: consideredOutflows.map((o) => o.occurrenceKey),

    flexibleMoneyHorizon: Math.round(flexibleMoneyHorizon),
    flexibleMoneyEndOfHorizon: Math.round(flexibleMoneyEndOfHorizon),

    lowestProjectedBalance: forecast.lowestProjectedBalance,
    lowestProjectedBalanceDate: forecast.lowestProjectedBalanceDate,
    obligationsCovered: forecast.obligationsCovered,
    reserveProtected: forecast.reserveProtected,
    // Inherited verbatim so "how was this calculated" shows the same reasons
    // the forecast used.
    assumptions: forecast.assumptions,
  };
}
