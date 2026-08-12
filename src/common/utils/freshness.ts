/**
 * Data freshness (spec 04 §12, §22).
 *
 * v3.1 leads with a forecast, and a forecast is only as trustworthy as the
 * balances it starts from. So the product tells the household how old its
 * picture is — and, crucially, does so **without implying they did something
 * wrong**. Stale data is a fact about the data, never a judgement about the
 * couple (§29's tone rules apply to every signal derived from this file).
 *
 * The cadence comes from the household's own `updateFrequency`. A household
 * that chose `manual` has explicitly said "we'll update when we want to";
 * calling their data stale on a schedule they never agreed to would be exactly
 * the nagging the product is built to avoid — so `manual` never goes stale.
 */

import type { UpdateFrequency } from '../../modules/households/entities/household.entity';
import { daysBetweenIso, type IsoDate } from './clock';

export type FreshnessState = 'fresh' | 'aging' | 'stale' | 'unknown';

/**
 * How many days a value stays trustworthy under a given cadence.
 *
 * `null` = never goes stale. Returned for `manual`, and it is a real value the
 * callers must handle — not a missing case.
 */
export function staleAfterDaysFor(
  updateFrequency: UpdateFrequency,
): number | null {
  switch (updateFrequency) {
    case 'weekly':
      // A week plus a day of grace: a household that updates every Sunday
      // shouldn't flip to stale for a few hours every Sunday morning.
      return 8;
    case 'monthly':
      // 31 covers the longest month, for the same reason.
      return 31;
    case 'manual':
      return null;
    default:
      return null;
  }
}

export interface FreshnessResult {
  state: FreshnessState;
  /** Null when the value has never been dated, or the cadence is `manual`. */
  daysSinceUpdate: number | null;
  staleAfterDays: number | null;
}

/**
 * Classify one value's age.
 *
 * `aging` exists so the UI has a calm middle step — a quiet "worth a look"
 * before anything reads as a problem. Without it every value would jump
 * straight from fine to stale.
 */
export function freshnessOf(
  asOfDate: IsoDate,
  updatedAt: string | null | undefined,
  updateFrequency: UpdateFrequency,
): FreshnessResult {
  const staleAfterDays = staleAfterDaysFor(updateFrequency);

  if (!updatedAt) {
    // Never dated. Not "stale" — we genuinely don't know, and saying stale
    // would assert something we can't support.
    return { state: 'unknown', daysSinceUpdate: null, staleAfterDays };
  }

  const daysSinceUpdate = Math.max(
    0,
    daysBetweenIso(updatedAt.slice(0, 10), asOfDate),
  );

  if (staleAfterDays === null) {
    return { state: 'fresh', daysSinceUpdate, staleAfterDays };
  }

  if (daysSinceUpdate >= staleAfterDays) {
    return { state: 'stale', daysSinceUpdate, staleAfterDays };
  }
  // The last quarter of the window is "aging".
  if (daysSinceUpdate >= staleAfterDays * 0.75) {
    return { state: 'aging', daysSinceUpdate, staleAfterDays };
  }
  return { state: 'fresh', daysSinceUpdate, staleAfterDays };
}
