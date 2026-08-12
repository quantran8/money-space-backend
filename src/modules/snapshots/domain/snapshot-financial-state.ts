/**
 * The financial state of a PAST snapshot (spec §10, 05 §6).
 *
 * Live financial state is derived from a full forecast run
 * (`forecast/domain/financial-state.ts`). A snapshot has no forecast to re-run
 * — by design: re-running today's engine over yesterday's row would produce a
 * number that changes every time you look at it, which is the opposite of what
 * a snapshot is for.
 *
 * So this derives the same four codes from the SIX foresight columns the
 * snapshot froze. It is deliberately a separate, smaller function rather than a
 * reuse of `deriveFinancialState`: pretending we have inputs we don't would be
 * worse than admitting the reduced set.
 *
 * It shares `FINANCIAL_STATE_THRESHOLDS`, so a threshold change moves the live
 * view and the history together — they can never disagree about what "tight"
 * means.
 */

import { FINANCIAL_STATE_THRESHOLDS } from '../../forecast/domain/financial-state';
import type { FinancialState } from '../../forecast/domain/financial-state';

export type SnapshotFinancialStateReason =
  | 'no_assets_recorded'
  | 'no_foresight_recorded'
  | 'lowest_projected_balance_negative'
  | 'reserve_significantly_breached'
  | 'forecast_near_reserve'
  | 'flexible_money_negative';

export interface SnapshotFinancialStateInput {
  /** NULL when the snapshot predates the foresight columns. */
  lowestProjectedBalance: number | null;
  flexibleMoney: number | null;
  protectedReserveAmount: number;
  assetLineCount: number;
}

export interface SnapshotFinancialStateResult {
  state: FinancialState;
  reasons: SnapshotFinancialStateReason[];
}

export function deriveSnapshotFinancialState(
  input: SnapshotFinancialStateInput,
): SnapshotFinancialStateResult {
  const t = FINANCIAL_STATE_THRESHOLDS;
  const reasons: SnapshotFinancialStateReason[] = [];

  if (input.assetLineCount === 0) {
    reasons.push('no_assets_recorded');
  }
  // Every snapshot taken before the v3.1 columns existed lands here. That is
  // `incomplete` — an honest "we didn't record this" — never a judgement
  // invented from the totals we happen to have.
  if (input.lowestProjectedBalance === null) {
    reasons.push('no_foresight_recorded');
  }

  if (input.lowestProjectedBalance !== null) {
    if (input.lowestProjectedBalance < 0) {
      reasons.push('lowest_projected_balance_negative');
    }
    if (
      input.protectedReserveAmount > 0 &&
      input.lowestProjectedBalance <
        input.protectedReserveAmount * t.reserveBreachRatio
    ) {
      reasons.push('reserve_significantly_breached');
    }
    if (
      input.protectedReserveAmount > 0 &&
      input.lowestProjectedBalance <
        input.protectedReserveAmount * t.nearReserveRatio
    ) {
      reasons.push('forecast_near_reserve');
    }
  }

  if (input.flexibleMoney !== null && input.flexibleMoney < 0) {
    reasons.push('flexible_money_negative');
  }

  const has = (reason: SnapshotFinancialStateReason) =>
    reasons.includes(reason);

  let state: FinancialState;
  if (has('no_assets_recorded') || has('no_foresight_recorded')) {
    state = 'incomplete';
  } else if (
    has('lowest_projected_balance_negative') ||
    has('reserve_significantly_breached')
  ) {
    state = 'tight';
  } else if (has('forecast_near_reserve') || has('flexible_money_negative')) {
    state = 'watch';
  } else {
    state = 'on_track';
  }

  return { state, reasons };
}
