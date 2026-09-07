import type { RedeemCodeStatus, RedeemGrantType } from '@prisma/client';
import type { SubscriptionRow } from '../domain/entitlement';
import type {
  EntitlementSource,
  EntitlementUsage,
  SubscriptionStatus,
  SubscriptionTier,
} from '../entities/entitlement.entity';

export const BILLING_REPOSITORY = Symbol('BILLING_REPOSITORY');

export interface RedeemCodeRow {
  id: string;
  code: string;
  campaign: string;
  status: RedeemCodeStatus;
  grantType: RedeemGrantType;
  grantDurationDays: number | null;
  grantUntil: Date | null;
  maxRedemptions: number;
  redemptionCount: number;
  expiresAt: Date | null;
}

export interface SubscriptionWrite {
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  source: EntitlementSource;
  trialStartedAt?: Date;
  trialEndsAt?: Date;
}

export interface RedemptionWrite {
  redeemCodeId: string;
  householdId: string;
  redeemedById: string;
  grantedDays: number | null;
  periodEndBefore: Date | null;
  periodEndAfter: Date | null;
}

export interface BillingRepository {
  /** `null` when the household has never been granted a plan. */
  findSubscription(householdId: string): Promise<SubscriptionRow | null>;

  /**
   * Read the row for update, holding it until the transaction commits.
   *
   * Without the lock, two grants arriving at once both read the old expiry and
   * one of the two extensions is lost.
   */
  lockSubscription(householdId: string): Promise<SubscriptionRow | null>;

  upsertSubscription(
    householdId: string,
    write: SubscriptionWrite,
  ): Promise<void>;

  /**
   * Current consumption of the counted quotas, minus what-if runs — those are
   * a Redis counter, not a table (see Phase 3).
   */
  countUsage(
    householdId: string,
  ): Promise<Omit<EntitlementUsage, 'whatIfThisMonth'>>;

  /** For the preview, which names the household being activated. */
  findHouseholdName(householdId: string): Promise<string>;

  /** Look up a normalized code. Includes disabled and exhausted ones. */
  findRedeemCode(code: string): Promise<RedeemCodeRow | null>;

  /** Whether this household has already redeemed this code. */
  hasRedeemed(redeemCodeId: string, householdId: string): Promise<boolean>;

  /**
   * Take one redemption slot, atomically.
   *
   * Returns false when the code is gone, disabled, expired, or out of slots.
   * The conditions live in the UPDATE's WHERE clause so Postgres re-evaluates
   * them for the second transaction after the first commits — which is what
   * makes this exactly-once. `withAdvisoryLock` is explicitly documented as
   * "advisory only, not exactly-once": right for a cron, wrong for money.
   */
  claimRedeemCodeSlot(codeId: string): Promise<boolean>;

  insertRedemption(write: RedemptionWrite): Promise<void>;

  /**
   * Stamp the receipt once the new expiry is known.
   *
   * Split from the insert because the row has to exist first — it is the unique
   * constraint that decides whether this household may redeem at all, and that
   * has to be settled before any period is computed.
   */
  updateRedemptionOutcome(
    redeemCodeId: string,
    householdId: string,
    outcome: {
      grantedDays: number;
      periodEndBefore: Date | null;
      periodEndAfter: Date | null;
    },
  ): Promise<void>;
}
