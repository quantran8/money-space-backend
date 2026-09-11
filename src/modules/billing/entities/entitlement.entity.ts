import type {
  EntitlementSource,
  SubscriptionStatus,
  SubscriptionTier,
} from '@prisma/client';

export type { EntitlementSource, SubscriptionStatus, SubscriptionTier };

/** Boolean capabilities. A guard can decide these on its own. */
export type PremiumFeature =
  | 'forecast_horizon_extended'
  | 'history_full'
  | 'export_data';

/** Counted quotas. A guard cannot check these — the service must, see §B.5. */
export type CountableQuota = 'goals' | 'whatIfPerMonth' | 'marketPricedAssets';

/**
 * What a tier allows. `null` means unlimited, never zero.
 *
 * This shape is sent to the client verbatim inside `GET /entitlement`, so the
 * frontend renders every limit from the server's answer and hardcodes no
 * number. Changing what Free includes is one edit here.
 */
export interface PlanLimits {
  /** Active goals. Completed ones do not occupy a slot. */
  goals: number | null;
  /** What-if runs per calendar month, Vietnam time. */
  whatIfPerMonth: number | null;
  /** Assets whose price refreshes automatically. */
  marketPricedAssets: number | null;
  /** Forecast horizons in days the household may request. */
  forecastHorizons: number[];
  /** Months of snapshot history that can be read back. */
  historyMonths: number | null;
  exportData: boolean;
}

/** Current usage of the counted quotas. Only computed for `GET /entitlement`. */
export interface EntitlementUsage {
  goals: number;
  whatIfThisMonth: number;
  marketPricedAssets: number;
}

export interface Entitlement {
  householdId: string;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  /**
   * ISO timestamp. `null` with `tier: premium` means lifetime; `null` with
   * `tier: free` means never purchased.
   */
  expiresAt: string | null;
  isLifetime: boolean;
  /**
   * Computed server-side on purpose: a client clock can be wrong, and the
   * difference between "0 days left" and "1 day left" is something the
   * household reads and acts on.
   */
  daysRemaining: number | null;
  source: EntitlementSource | null;
  /** Premium, but on the free trial rather than a purchase. */
  isTrial: boolean;
  /** A household that has used its trial is never offered another. */
  trialUsed: boolean;
  /** How long the trial on offer lasts. 0 when trials are switched off. */
  trialDays: number;
  limits: PlanLimits;
  /**
   * Present only on `GET /entitlement`, which queries for it. Left out of the
   * cached value the guards read — counting on every request would cost queries
   * for an answer almost nothing needs.
   */
  usage?: EntitlementUsage;
}
