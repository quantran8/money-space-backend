import { HttpException, HttpStatus } from '@nestjs/common';
import type { Entitlement } from './entities/entitlement.entity';

/** Which wall the household just hit. The client picks the paywall from this. */
export type PaywallReason =
  | 'goal_quota'
  | 'whatif_quota'
  | 'auto_price_quota'
  | 'forecast_horizon'
  | 'history'
  | 'export'
  | 'expired'
  | 'general';

/**
 * 402 Payment Required — deliberately not 403.
 *
 * 403 already has a specific meaning here: "you are not a member of this
 * household" (`HouseholdAccessGuard`). If the paywall used it too, the client
 * could not tell "signed into the wrong household" from "needs upgrading", and
 * `ApiError` carries only a status code. 402 is the one status that means
 * exactly this.
 *
 * `message` is a CODE, never a sentence — the same rule the journal follows in
 * `audit.types.ts`: the client owns all copy.
 */
export class PremiumRequiredException extends HttpException {
  constructor(
    reason: PaywallReason,
    entitlement: Entitlement,
    meta: Record<string, unknown> = {},
  ) {
    super(
      {
        message: 'premium_required',
        error: 'PremiumRequired',
        // Everything needed to open the right paywall, so the client never has
        // to make a second request to find out what it hit.
        premium: {
          reason,
          currentTier: entitlement.tier,
          status: entitlement.status,
          limits: entitlement.limits,
          ...meta,
        },
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

/** Why a trial could not be started. A code, never a sentence. */
export type TrialRefusal =
  | 'trial_already_used'
  | 'already_premium'
  | 'trial_disabled';

/**
 * 409, not 402 — the household is not being asked to pay, the trial is simply
 * not on offer. See memory/billing-and-entitlement.md.
 */
export class TrialUnavailableException extends HttpException {
  constructor(reason: TrialRefusal) {
    super(
      {
        message: 'trial_unavailable',
        error: 'TrialUnavailable',
        trial: { reason },
      },
      HttpStatus.CONFLICT,
    );
  }
}
