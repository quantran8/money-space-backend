import { PLAN_LIMITS } from '../constants/plan-limits';
import type {
  Entitlement,
  EntitlementSource,
  SubscriptionStatus,
  SubscriptionTier,
} from '../entities/entitlement.entity';

/** The stored row, or `null` when the household has never had a plan. */
export interface SubscriptionRow {
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  source: EntitlementSource | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days until `end`, rounded UP: with eleven hours left a household has
 * "1 day", not "0 days". Zero means it has already lapsed.
 */
function daysUntil(end: Date, now: Date): number {
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / MS_PER_DAY));
}

/**
 * Resolve a stored row into what the household may actually do right now.
 *
 * Pure, and the reason the 15-minute cache TTL is safe: what gets cached is the
 * ROW, while the comparison against `now` happens on every single call. A plan
 * therefore stops granting Premium the moment it expires, not when the cache
 * entry does.
 *
 * A missing row and `tier: 'free'` are the same thing, which is why no
 * migration had to backfill existing households.
 */
export function resolveEntitlement(
  householdId: string,
  row: SubscriptionRow | null,
  now: Date,
): Entitlement {
  if (!row) {
    return {
      householdId,
      tier: 'free',
      status: 'active',
      expiresAt: null,
      isLifetime: false,
      daysRemaining: null,
      source: null,
      isTrial: false,
      trialUsed: false,
      limits: PLAN_LIMITS.free,
    };
  }

  // `currentPeriodEnd: null` on a premium row is a lifetime grant, so only a
  // row that HAS an end date can be past it.
  const lapsed =
    row.currentPeriodEnd !== null && row.currentPeriodEnd.getTime() <= now.getTime();

  const isPremium =
    row.tier === 'premium' && row.status === 'active' && !lapsed;

  // `tier` is deliberately reported as stored even once the plan has lapsed:
  // it lets the UI say "your Premium expired on the 3rd" instead of "you are on
  // Free", which is the difference between a win-back and a shrug. What the
  // household may DO comes from `limits`, which has already dropped to free.
  const status: SubscriptionStatus = isPremium ? 'active' : 'expired';

  return {
    householdId,
    tier: row.tier,
    status: row.tier === 'free' ? 'active' : status,
    expiresAt: row.currentPeriodEnd?.toISOString() ?? null,
    isLifetime: row.tier === 'premium' && row.currentPeriodEnd === null,
    daysRemaining: row.currentPeriodEnd
      ? daysUntil(row.currentPeriodEnd, now)
      : null,
    source: row.source,
    isTrial: isPremium && row.source === 'trial',
    // Having started one at any point is what disqualifies a second, so this
    // stays true long after the trial itself has ended.
    trialUsed: row.trialStartedAt !== null,
    limits: isPremium ? PLAN_LIMITS.premium : PLAN_LIMITS.free,
  };
}
