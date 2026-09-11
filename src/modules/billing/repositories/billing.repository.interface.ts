import type {
  PaymentOrderStatus,
  PaymentProvider,
  PurchaseStore,
  RedeemCodeStatus,
  RedeemGrantType,
} from '@prisma/client';
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

export interface PaymentOrderRow {
  id: string;
  householdId: string;
  status: PaymentOrderStatus;
  /** `null` on an in-app purchase: those never get a PayOS order reference. */
  orderCode: bigint | null;
  planCode: string;
  amount: number;
  durationDays: number | null;
  /** Which paywall sent them to checkout. NULL = opened from the plans page. */
  fromReason: string | null;
  providerTxnId: string | null;
  checkoutUrl: string | null;
  createdAt: Date;
  paidAt: Date | null;
  provider?: PaymentProvider;
  store?: PurchaseStore | null;
  productId?: string | null;
  storeExpiresAt?: Date | null;
}

/**
 * A settled in-app purchase, written in one go.
 *
 * Unlike a PayOS order there is no pending step: the store has already taken
 * the money by the time RevenueCat tells us, so the row is created `paid`.
 */
export interface StorePurchaseWrite {
  id: string;
  householdId: string;
  /** NULL for a store-initiated renewal — nobody pressed anything. */
  createdById: string | null;
  planCode: string;
  amount: number;
  durationDays: number | null;
  /** The unique idempotency key. A replay violates this and is swallowed. */
  providerTxnId: string;
  providerUserId: string;
  productId: string;
  store: PurchaseStore | null;
  storeExpiresAt: Date | null;
  paidAt: Date;
  rawPayload: unknown;
}

export interface RevenuecatSubscriberRow {
  providerUserId: string;
  profileId: string | null;
  householdId: string;
}

export interface PaymentOrderWrite {
  id: string;
  householdId: string;
  createdById: string;
  orderCode: bigint;
  planCode: string;
  amountOriginal: number;
  discountAmount: number;
  amount: number;
  durationDays: number | null;
  expiresAt: Date;
  /** Which paywall sent them here. NULL = opened from the plans page. */
  fromReason: string | null;
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
  insertPaymentOrder(write: PaymentOrderWrite): Promise<void>;

  /** Attach the hosted checkout once the gateway has issued it. */
  attachCheckout(
    orderCode: bigint,
    checkout: { checkoutUrl: string; providerOrderId: string },
  ): Promise<void>;

  findPaymentOrderByCode(orderCode: bigint): Promise<PaymentOrderRow | null>;

  /** The household's orders, newest first. */
  listPaymentOrders(
    householdId: string,
    limit: number,
  ): Promise<PaymentOrderRow[]>;

  /**
   * Settle an order, atomically and exactly once.
   *
   * Returns false when the order was already settled — the UPDATE carries
   * `status = 'pending'` in its WHERE clause, so a second webhook delivery
   * matches no row rather than granting a second period. Combined with the
   * unique `provider_txn_id`, a replay cannot pay twice by any route.
   */
  markPaymentOrderPaid(
    orderCode: bigint,
    settlement: {
      providerTxnId: string;
      paidAt: Date;
      rawPayload: unknown;
    },
  ): Promise<boolean>;

  /**
   * Flip lapsed premium subscriptions to `expired`, returning the households
   * touched so their entitlement caches can be dropped. Only `status` moves —
   * `tier` stays `premium`. Lifetime rows (`currentPeriodEnd IS NULL`) fall
   * outside the comparison with no special case.
   */
  expireLapsedSubscriptions(now: Date, limit: number): Promise<string[]>;

  /** Close pending orders nobody ever paid. Returns how many were closed. */
  expireStalePaymentOrders(now: Date, limit: number): Promise<number>;

  /** Close an order without granting anything. */
  markPaymentOrderClosed(
    orderCode: bigint,
    status: 'cancelled' | 'expired',
  ): Promise<void>;

  /** Record what arrived when it does not settle the order (an underpayment). */
  recordPaymentPayload(orderCode: bigint, rawPayload: unknown): Promise<void>;

  /**
   * Insert a settled store purchase.
   *
   * Throws a unique violation when `providerTxnId` already exists — that IS the
   * idempotency barrier for in-app purchases, and the caller is expected to
   * catch it rather than check first, because two deliveries can race.
   */
  insertStorePurchase(write: StorePurchaseWrite): Promise<void>;

  /** The household a RevenueCat subscriber's money pays for. */
  findRevenuecatSubscriber(
    providerUserIds: string[],
  ): Promise<RevenuecatSubscriberRow | null>;

  /**
   * Remember which household a subscriber pays for.
   *
   * The household is only set on INSERT. A person who later joins a different
   * household must not have their running subscription start paying for the new
   * one, so an existing row keeps its household and only refreshes the profile
   * link.
   */
  linkRevenuecatSubscriber(link: {
    providerUserId: string;
    profileId: string | null;
    householdId: string;
  }): Promise<void>;

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
