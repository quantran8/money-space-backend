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
 *
 * There used to be three flexible-money figures here. Two of them — the horizon
 * form and the end-of-horizon form — existed only to subtract the protected
 * reserve from `lowestProjectedBalance` / `endingProjectedBalance`. With the
 * reserve gone they were those two numbers under a second name, so they are
 * gone too: a response with two names for one figure invites the client to
 * treat them as different things. Callers read the forecast's balances directly.
 */

import type { IsoDate } from '../../../common/utils/clock';
import type { CalculationAssumption, ForecastResult } from './forecast.types';

export interface FlexibleMoneyResult {
  asOfDate: IsoDate;
  horizonDays: number;
  currentSharedLiquidMoney: number;

  /** §26B conservative form. MAY BE NEGATIVE. */
  flexibleMoneyToday: number;
  requiredOutflowsBeforeNextInflow: number;
  nextSufficientlyCertainInflow: { date: IsoDate; amount: number } | null;
  /** The occurrence keys behind the subtraction, for "how was this computed". */
  consideredOutflowKeys: string[];

  /**
   * The horizon figure — what the household can spend without the projected
   * balance ever going negative. MAY BE NEGATIVE. This is what what-if compares
   * before/after.
   */
  lowestProjectedBalance: number;
  lowestProjectedBalanceDate: IsoDate;
  /** End-of-horizon variant; must be labelled with its assumption when shown. */
  endingProjectedBalance: number;
  obligationsCovered: boolean;
  /**
   * Liquid money the household's GOALS already claim — money set aside behind a
   * goal, plus what this month's pace can still draw from what is left.
   *
   * Separate from `requiredOutflowsBeforeNextInflow`, which is about bills. Both
   * are "already has a job", but only one of them leaves the household on a
   * date; goal money simply stops being free.
   *
   * Passed in by the caller rather than derived here, because it needs the goals
   * and their allocations, and this module is pure forecast arithmetic.
   */
  goalCommitments: number;
  assumptions: CalculationAssumption[];
}

export function computeFlexibleMoney(
  forecast: ForecastResult,
  /**
   * What the goals already claim of the same liquid money this forecast starts
   * from. Defaults to 0 so callers that only need cash-flow arithmetic — what-if,
   * the projection — are unaffected.
   */
  goalCommitments = 0,
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
    forecast.startingLiquidBalance - requiredOutflowsBeforeNextInflow;

  return {
    asOfDate: forecast.asOfDate,
    horizonDays: forecast.horizonDays,
    currentSharedLiquidMoney: forecast.startingLiquidBalance,

    // Deliberately NOT clamped at zero — negative is the signal.
    flexibleMoneyToday: Math.round(flexibleMoneyToday),
    requiredOutflowsBeforeNextInflow: Math.round(
      requiredOutflowsBeforeNextInflow,
    ),
    nextSufficientlyCertainInflow: nextInflow
      ? { date: nextInflow.date, amount: nextInflow.amount }
      : null,
    consideredOutflowKeys: consideredOutflows.map((o) => o.occurrenceKey),

    lowestProjectedBalance: forecast.lowestProjectedBalance,
    lowestProjectedBalanceDate: forecast.lowestProjectedBalanceDate,
    endingProjectedBalance: forecast.endingProjectedBalance,
    obligationsCovered: forecast.obligationsCovered,
    goalCommitments: Math.round(goalCommitments),
    // Inherited verbatim so "how was this calculated" shows the same reasons
    // the forecast used.
    assumptions: forecast.assumptions,
  };
}
