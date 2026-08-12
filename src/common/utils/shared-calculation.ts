/**
 * The shared-calculation rule (spec v3.1 §11, §30).
 *
 * Whether a record counts toward the household's shared picture — net worth,
 * forecast, flexible money — is **derived**, never stored. The spec is explicit
 * that there must be no `included_in_household_calculation` column: two
 * independent axes decide it, and a stored flag would drift from them.
 *
 *   - `financial_nature` — whose money it fundamentally is.
 *   - `visibility_level` — how much the partner is allowed to see.
 *
 * A record drops out of the shared calculation when either axis says "this is
 * not ours to count":
 *
 *   - `visibility_level = 'private'` → the partner can't see it AND it doesn't
 *     participate in shared totals. This is the strongest setting in the UI.
 *   - `financial_nature = 'personal_private'` → personal money that was never
 *     part of the household picture.
 *
 * Everything else counts, including `personal_included` (personal money the
 * owner chose to count) and `managed_for_household` (money one person holds on
 * the household's behalf). `summary_only` and `grouped` still count toward the
 * total — they only limit how much *detail* the partner sees, which is a
 * presentation concern, not a calculation one.
 */

import type { VisibilityLevel } from './money-space.utils';

/** Whose money this fundamentally is (spec §11). */
export type FinancialNature =
  | 'household'
  | 'personal_included'
  | 'managed_for_household'
  | 'personal_private';

/**
 * The minimum shape the rule needs. Records without a `financialNature` of
 * their own (cashflow events, money events) simply pass `undefined` and are
 * judged on visibility alone.
 */
export interface SharedCalculationSubject {
  financialNature?: FinancialNature | null;
  visibilityLevel: VisibilityLevel;
}

/**
 * `true` when the record participates in the household's shared totals and
 * forecast.
 *
 * This is applied in two places on purpose: in the repository WHERE clause so
 * the hot read path never loads excluded rows, and again inside the pure
 * calculation functions so the rule is unit-testable and a future caller that
 * forgets the SQL filter still gets the right answer.
 */
export function isIncludedInSharedCalculation(
  record: SharedCalculationSubject,
): boolean {
  if (record.visibilityLevel === 'private') {
    return false;
  }
  if (record.financialNature === 'personal_private') {
    return false;
  }
  return true;
}

/**
 * The Prisma `where` fragment matching {@link isIncludedInSharedCalculation}
 * for tables that carry both axes (currently only `assets`).
 *
 * Keep this in lockstep with the predicate above — they are two encodings of
 * one rule, and the calculation tests assert they agree.
 */
export const SHARED_CALCULATION_ASSET_WHERE = {
  visibilityLevel: { not: 'private' as const },
  financialNature: { not: 'personal_private' as const },
};

/**
 * The same fragment for tables that only carry `visibility_level`
 * (`cashflow_events`, `money_events`).
 */
export const SHARED_CALCULATION_VISIBILITY_WHERE = {
  visibilityLevel: { not: 'private' as const },
};
