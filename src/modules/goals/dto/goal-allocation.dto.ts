import type {
  GoalAllocationKind,
  GoalAllocationRole,
} from '../entities/financial-goal.entity';

/**
 * Declare how much of one asset counts towards an `asset_backed` goal.
 *
 * Exactly one of `allocatedAmount` / `percent` is required, matching `kind`:
 *
 * - `fixed` — "50tr of my stocks". Stays put when the asset reprices, and is
 *   capped at the asset's value on read, so a price fall lowers the goal
 *   without needing any write.
 * - `percent` — "all of my gold", "half of this account". Tracks the asset's
 *   value up and down.
 *
 * These DTOs are plain interfaces (this repo does not use class-validator), so
 * every rule above is enforced in `GoalsService`.
 */
export interface CreateGoalAllocationDto {
  assetId: string;
  kind: GoalAllocationKind;
  /**
   * Whether this share is money being contributed or value already held. Omit
   * to take the asset type's default (wallet → `contribution`).
   */
  role?: GoalAllocationRole;
  /**
   * How much this wallet is meant to put into the goal each month, in VND.
   *
   * Allowed ONLY on a `contribution` share of a `cash`/`bank_account` asset —
   * the goal's pace is the sum of these, and a pace declared against gold names
   * no account the money could come out of. Omit for "this wallet is behind the
   * goal but feeds it no fixed amount".
   */
  monthlyContribution?: number;
  /**
   * This goal's share (1–100) of the wallet's remaining monthly room, used only
   * when goals tied at the same priority cannot all be paid in full.
   *
   * Ask for it when the chosen wallet already backs another goal at the SAME
   * priority — that is the tie `priority` cannot break. Omit otherwise: a wallet
   * with one goal on it has nothing to split, and a share nobody was asked for
   * is worse than none.
   */
  sharePercent?: number;
  /** Required when `kind = 'fixed'`. VND, >= 0. */
  allocatedAmount?: number;
  /** Required when `kind = 'percent'`. 0 < percent <= 100. */
  percent?: number;
  note?: string;
}

/**
 * Every field optional, but `kind` still governs which value column may be set:
 * changing the kind requires sending the value that kind needs, because the
 * unused column is cleared on write (the DB CHECK allows exactly one).
 */
export interface UpdateGoalAllocationDto {
  kind?: GoalAllocationKind;
  role?: GoalAllocationRole;
  /** Send `null` to stop this wallet declaring a monthly amount. */
  monthlyContribution?: number | null;
  /** Send `null` to drop this goal's declared share of the wallet. */
  sharePercent?: number | null;
  allocatedAmount?: number;
  percent?: number;
  note?: string;
}
