import type { SubscriptionRow } from '../domain/entitlement';
import type { EntitlementUsage } from '../entities/entitlement.entity';

export const BILLING_REPOSITORY = Symbol('BILLING_REPOSITORY');

export interface BillingRepository {
  /** `null` when the household has never been granted a plan. */
  findSubscription(householdId: string): Promise<SubscriptionRow | null>;

  /**
   * Current consumption of the counted quotas, minus what-if runs — those are
   * a Redis counter, not a table (see `WhatIfUsageService` in Phase 3).
   */
  countUsage(
    householdId: string,
  ): Promise<Omit<EntitlementUsage, 'whatIfThisMonth'>>;
}
