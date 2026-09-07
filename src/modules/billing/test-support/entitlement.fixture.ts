import { PLAN_LIMITS } from '../constants/plan-limits';
import type { Entitlement } from '../entities/entitlement.entity';

/**
 * A premium entitlement, for specs whose subject is not the plan.
 *
 * Most service tests predate billing and are about the money rules; handing
 * them Premium keeps the gates out of the way, so a failing quota test means
 * the quota is wrong rather than that an unrelated fixture drifted.
 */
export function premiumEntitlement(
  over: Partial<Entitlement> = {},
): Entitlement {
  return {
    householdId: 'hh-1',
    tier: 'premium',
    status: 'active',
    expiresAt: null,
    isLifetime: true,
    daysRemaining: null,
    source: 'manual_grant',
    isTrial: false,
    trialUsed: false,
    limits: PLAN_LIMITS.premium,
    ...over,
  };
}

/** A household on the free plan, at the real Free ceilings. */
export function freeEntitlement(over: Partial<Entitlement> = {}): Entitlement {
  return {
    householdId: 'hh-1',
    tier: 'free',
    status: 'active',
    expiresAt: null,
    isLifetime: false,
    daysRemaining: null,
    source: null,
    isTrial: false,
    trialUsed: false,
    limits: PLAN_LIMITS.free,
    ...over,
  };
}
