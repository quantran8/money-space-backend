import { Inject, Injectable } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';
import { extendPeriod, type Grant } from './domain/extend-period';
import type { EntitlementSource } from './entities/entitlement.entity';
import {
  BILLING_REPOSITORY,
  type BillingRepository,
} from './repositories/billing.repository.interface';

export interface GrantResult {
  periodEnd: Date | null;
  periodEndBefore: Date | null;
  addedDays: number;
  stacked: boolean;
  /** The grant changed nothing — the caller should not consume anything. */
  noop: boolean;
}

/**
 * The only writer of `household_subscriptions`.
 *
 * Everything that can hand a household Premium — a code, a payment, a manual
 * grant, the signup trial — comes through `grantOrExtend`, so the stacking
 * rules exist once and the entitlement cache is dropped in exactly one place.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    @Inject(BILLING_REPOSITORY)
    private readonly billingRepository: BillingRepository,
    private readonly entitlements: EntitlementService,
  ) {}

  /**
   * Apply a grant, stacking it onto whatever the household already has.
   *
   * Callers that need this to be atomic with their own writes (redeeming a code
   * must claim the slot and extend the period together) run it inside their own
   * transaction — every repository call joins the active one automatically.
   */
  async grantOrExtend(
    householdId: string,
    grant: Grant,
    source: EntitlementSource,
    now = new Date(),
  ): Promise<GrantResult> {
    // FOR UPDATE: without it, two grants arriving together both read the old
    // expiry and one of them is silently lost.
    const current = await this.billingRepository.lockSubscription(householdId);

    const result = extendPeriod({
      currentPeriodEnd: current?.currentPeriodEnd ?? null,
      isLifetime:
        current?.tier === 'premium' && current.currentPeriodEnd === null,
      now,
      grant,
    });

    if (!result.noop) {
      await this.billingRepository.upsertSubscription(householdId, {
        tier: 'premium',
        status: 'active',
        currentPeriodEnd: result.periodEnd,
        source,
      });
      await this.entitlements.invalidate(householdId);
    }

    return {
      periodEnd: result.periodEnd,
      periodEndBefore: current?.currentPeriodEnd ?? null,
      addedDays: result.addedDays,
      stacked: result.stacked,
      noop: result.noop,
    };
  }

  /**
   * The signup trial. Skipped silently when the household has ever had one —
   * `trialStartedAt` is what disqualifies a second, and it outlives the trial
   * itself.
   */
  async startTrialIfEligible(
    householdId: string,
    days: number,
    now = new Date(),
  ): Promise<boolean> {
    const current = await this.billingRepository.findSubscription(householdId);
    if (current?.trialStartedAt) return false;
    // Never downgrade someone who already paid.
    if (current?.tier === 'premium') return false;

    const endsAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    await this.billingRepository.upsertSubscription(householdId, {
      tier: 'premium',
      status: 'active',
      currentPeriodEnd: endsAt,
      source: 'trial',
      trialStartedAt: now,
      trialEndsAt: endsAt,
    });
    await this.entitlements.invalidate(householdId);
    return true;
  }
}
