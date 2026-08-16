/**
 * Financial state (spec 05 §6, §10).
 *
 * One calm word for "how are we doing" — `on_track | watch | tight |
 * incomplete`. Replaces the old `good | attention | tight | insufficient_data`.
 *
 * The backend returns CODES and never a sentence. 05 §6 closes with "không diễn
 * đạt các state như judgment": the difference between "Tight" and "You're
 * overspending" is the difference between a tool a couple keeps using and one
 * they resent. Copy is the client's job.
 */

import type { CalculationAssumption, ForecastResult } from './forecast.types';
import type { FlexibleMoneyResult } from './flexible-money';

export type FinancialState = 'on_track' | 'watch' | 'tight' | 'incomplete';

export type FinancialStateReason =
  | 'no_liquid_sources'
  | 'no_cashflow_events'
  | 'required_payment_not_covered'
  | 'lowest_projected_balance_negative'
  | 'flexible_money_low'
  | 'large_payment_upcoming'
  | 'unconfirmed_critical_data'
  | 'stale_data';

export interface FinancialStateResult {
  state: FinancialState;
  /** EVERY reason that fired, not just the winning one. */
  reasons: FinancialStateReason[];
  horizonDays: number;
  assumptions: CalculationAssumption[];
}

/**
 * Exported so a threshold change is a deliberate edit with a failing test,
 * rather than a magic number quietly drifting.
 */
export const FINANCIAL_STATE_THRESHOLDS = {
  /** Flexible money below this share of horizon obligations → watch. */
  flexibleMoneyLowRatio: 0.1,
  /** A single required outflow at/above this share of liquid → watch. */
  largePaymentRatio: 0.3,
  /** At/above this share of liquid value going stale → watch. */
  staleAssetRatio: 0.34,
} as const;

export function deriveFinancialState(
  forecast: ForecastResult,
  flexible: FlexibleMoneyResult,
): FinancialStateResult {
  const t = FINANCIAL_STATE_THRESHOLDS;
  const reasons: FinancialStateReason[] = [];

  // --- incomplete: absence of data is not a judgement about money ----------
  if (forecast.usableNowAssetCount === 0) {
    reasons.push('no_liquid_sources');
  }
  if (forecast.liveEventCount === 0) {
    reasons.push('no_cashflow_events');
  }

  // --- tight ---------------------------------------------------------------
  if (!forecast.obligationsCovered) {
    reasons.push('required_payment_not_covered');
  }
  if (forecast.lowestProjectedBalance < 0) {
    reasons.push('lowest_projected_balance_negative');
  }

  // --- watch ---------------------------------------------------------------
  const horizonObligations = forecast.totals.requiredOutgoingAmount;
  if (
    horizonObligations > 0 &&
    flexible.flexibleMoneyToday < horizonObligations * t.flexibleMoneyLowRatio
  ) {
    reasons.push('flexible_money_low');
  }
  if (forecast.startingLiquidBalance > 0) {
    const largest = forecast.timeline
      .filter((o) => o.direction === 'outgoing' && o.requirement === 'required')
      .reduce((max, o) => Math.max(max, o.amount), 0);
    if (largest >= forecast.startingLiquidBalance * t.largePaymentRatio) {
      reasons.push('large_payment_upcoming');
    }
  }
  if (forecast.timeline.some((o) => o.status === 'pending_confirmation')) {
    reasons.push('unconfirmed_critical_data');
  }
  if (
    forecast.usableNowAssetCount > 0 &&
    forecast.staleAssetIds.length / forecast.usableNowAssetCount >=
      t.staleAssetRatio
  ) {
    reasons.push('stale_data');
  }

  // Precedence: first match wins for `state`; every reason still surfaces.
  const has = (reason: FinancialStateReason) => reasons.includes(reason);

  let state: FinancialState;
  if (has('no_liquid_sources') || has('no_cashflow_events')) {
    state = 'incomplete';
  } else if (
    has('required_payment_not_covered') ||
    has('lowest_projected_balance_negative')
  ) {
    state = 'tight';
  } else if (
    has('flexible_money_low') ||
    has('large_payment_upcoming') ||
    has('unconfirmed_critical_data') ||
    has('stale_data')
  ) {
    state = 'watch';
  } else {
    state = 'on_track';
  }

  return {
    state,
    reasons,
    horizonDays: forecast.horizonDays,
    assumptions: forecast.assumptions,
  };
}
