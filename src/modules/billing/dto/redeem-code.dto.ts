import type { Entitlement } from '../entities/entitlement.entity';

/** Plain interface, validated by hand in the service — the repo convention. */
export interface RedeemCodeDto {
  code: string;
}

/**
 * Why a code cannot be used. A CODE, not a sentence — the client owns all copy.
 *
 * Everything that is the code's own fault collapses to `invalid`: not found,
 * malformed, failed checksum, disabled, withdrawn. The three that follow do
 * admit a code exists, which is a deliberate trade: someone holding a genuinely
 * expired code needs to be told that, or they will retype it and conclude the
 * app is broken. An attacker only sees those three after already guessing a
 * real code, at which point the leak is moot.
 */
export type RedeemFailureReason =
  | 'invalid'
  | 'expired'
  | 'exhausted'
  | 'already_used'
  /** Valid, but it would change nothing — an earlier date, or already lifetime. */
  | 'no_effect';

export interface RedeemCodePreview {
  /** Normalized, echoed back so the household can confirm what was read. */
  code: string;
  valid: boolean;
  reason: RedeemFailureReason | null;
  /** Which household this would activate. Shown to catch the wrong-household case. */
  householdName: string;
  grant: {
    /** Days actually added, after stacking. 0 when the code changes nothing. */
    addedDays: number;
    /** New expiry, ISO. `null` = lifetime. */
    periodEndAfter: string | null;
    /** True when this extends a period that is still running. */
    stacked: boolean;
    isLifetime: boolean;
  } | null;
}

export interface RedeemCodeResult {
  redeemed: true;
  code: string;
  addedDays: number;
  /** The new state in full, so the client can update without refetching. */
  entitlement: Entitlement;
}
