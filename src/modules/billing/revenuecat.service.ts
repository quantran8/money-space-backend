import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '../../common/utils/uuid';
import { CacheInvalidator } from '../../common/cache/cache-invalidator.service';
import { AuditService } from '../../common/audit/audit.service';
import { billingConfig } from '../../config/billing.config';
import { PLAN_CATALOG } from './constants/plan-catalog';
import { planCodeForProduct } from './constants/store-products';
import {
  GRANTING_EVENTS,
  REVOCATION_EVENTS,
  purchaseStoreOf,
  subscriberIdsOf,
  transactionKeyOf,
  type RevenuecatEvent,
  type RevenuecatWebhookBody,
} from './domain/revenuecat-event';
import { SubscriptionService } from './subscription.service';
import {
  BILLING_REPOSITORY,
  type BillingRepository,
} from './repositories/billing.repository.interface';
import { isUniqueViolation } from '../../common/repositories/prisma-errors';

/**
 * What the webhook did, for the log. Never returned to RevenueCat — the
 * response says only that the delivery was received.
 */
export type RevenuecatOutcome =
  | 'granted'
  | 'already_handled'
  | 'unauthorized'
  | 'unknown_product'
  | 'unknown_subscriber'
  | 'wrong_entitlement'
  | 'sandbox_ignored'
  | 'revocation_logged'
  | 'ignored';

/**
 * In-app purchases, settled.
 *
 * The client never grants itself anything — this webhook is what moves the
 * expiry, through the same `grantOrExtend` a code and a PayOS payment use.
 * See `memory/billing-and-entitlement.md`.
 */
@Injectable()
export class RevenuecatService {
  private readonly logger = new Logger(RevenuecatService.name);

  constructor(
    @Inject(BILLING_REPOSITORY)
    private readonly billingRepository: BillingRepository,
    private readonly subscriptions: SubscriptionService,
    private readonly cacheInvalidator: CacheInvalidator,
    private readonly audit: AuditService,
  ) {}

  /**
   * Record which household a subscriber's purchases pay for.
   *
   * Called by the client BEFORE it opens the store sheet, and this is what
   * makes a renewal settleable a year later: Apple charges the card with no app
   * running, and the webhook carries only `app_user_id`. Without a stored
   * mapping that money would arrive for a household we could not name.
   *
   * Deliberately not derived per-webhook from "whichever household this profile
   * is in now" — a person who leaves and joins another household would
   * otherwise have their running subscription start paying for the new one.
   */
  async linkSubscriber(
    householdId: string,
    profileId: string,
    providerUserId: string,
  ): Promise<{ linked: true }> {
    await this.billingRepository.linkRevenuecatSubscriber({
      providerUserId,
      profileId,
      householdId,
    });
    return { linked: true };
  }

  /**
   * Handle one delivery. Answers a settled outcome for everything it
   * understands; only a transient failure throws, because only that is worth
   * a retry.
   */
  async handleWebhook(body: RevenuecatWebhookBody): Promise<RevenuecatOutcome> {
    const event = body?.event;
    if (!event?.type) {
      // RevenueCat sends a TEST event when the webhook URL is saved.
      this.logger.log('RevenueCat webhook received with no event');
      return 'ignored';
    }

    if (REVOCATION_EVENTS.has(event.type)) {
      return this.recordRevocation(event);
    }

    if (!GRANTING_EVENTS.has(event.type)) {
      // CANCELLATION and EXPIRATION land here on purpose: cancelling only
      // turns auto-renew off, and the expiry cron ends the period.
      this.logger.log(`RevenueCat event ${event.type} needs no action`);
      return 'ignored';
    }

    // A sandbox receipt is free money. Allowed only where testing needs it.
    if (event.environment === 'SANDBOX' && !billingConfig.revenuecatAllowSandbox) {
      this.logger.warn('RevenueCat SANDBOX purchase ignored in this environment');
      return 'sandbox_ignored';
    }

    const expected = billingConfig.revenuecatEntitlementId;
    const entitlementIds = event.entitlement_ids ?? [];
    // Guards against a product attached to the wrong entitlement in the
    // dashboard quietly handing out Premium.
    if (expected && entitlementIds.length > 0 && !entitlementIds.includes(expected)) {
      this.logger.warn(
        `RevenueCat event for entitlements [${entitlementIds.join(', ')}], expected ${expected}`,
      );
      return 'wrong_entitlement';
    }

    const planCode = planCodeForProduct(event.product_id);
    if (!planCode) {
      // Our configuration is wrong. Retrying cannot make it known.
      this.logger.error(
        `RevenueCat event for unknown product ${event.product_id ?? '(none)'}`,
      );
      return 'unknown_product';
    }

    const transactionId = transactionKeyOf(event);
    if (!transactionId) {
      this.logger.warn('RevenueCat granting event carried no transaction id');
      return 'ignored';
    }

    const subscriberIds = subscriberIdsOf(event);
    const subscriber =
      await this.billingRepository.findRevenuecatSubscriber(subscriberIds);

    if (!subscriber) {
      // Money we cannot attribute: somebody paid and is not getting it.
      this.logger.error(
        `RevenueCat purchase for unknown subscriber ${event.app_user_id ?? '(none)'} — ` +
          `product ${event.product_id}, txn ${transactionId}`,
      );
      return 'unknown_subscriber';
    }

    try {
      await this.settle(event, subscriber.householdId, planCode, transactionId);
    } catch (error) {
      // The unique `provider_txn_id` fired — a replay, or a lost race. That
      // IS the idempotency barrier working.
      if (isUniqueViolation(error)) {
        this.logger.log(`RevenueCat txn ${transactionId} already handled`);
        return 'already_handled';
      }
      // Transient — rethrown so RevenueCat retries.
      throw error;
    }

    return 'granted';
  }

  /**
   * Write the receipt and extend the period in ONE transaction, so there is no
   * moment for a crash to land in between them.
   */
  private async settle(
    event: RevenuecatEvent,
    householdId: string,
    planCode: keyof typeof PLAN_CATALOG,
    transactionId: string,
  ): Promise<void> {
    const durationDays = PLAN_CATALOG[planCode].durationDays;

    await this.cacheInvalidator.runInTransactionAndInvalidate(
      householdId,
      async () => {
        await this.billingRepository.insertStorePurchase({
          id: uuidv7(),
          householdId,
          // A renewal has no actor — naming whoever first subscribed would be
          // a guess the journal would state as fact.
          createdById: null,
          planCode,
          // What the STORE charged, not our list price.
          amount: Math.round(event.price_in_purchased_currency ?? event.price ?? 0),
          durationDays,
          providerTxnId: transactionId,
          providerUserId: event.app_user_id ?? '',
          productId: event.product_id ?? '',
          store: purchaseStoreOf(event.store),
          storeExpiresAt: event.expiration_at_ms
            ? new Date(event.expiration_at_ms)
            : null,
          paidAt: event.purchased_at_ms
            ? new Date(event.purchased_at_ms)
            : new Date(),
          rawPayload: event,
        });

        const grant =
          durationDays === null
            ? ({ type: 'lifetime' } as const)
            : ({ type: 'duration_days', days: durationDays } as const);

        const result = await this.subscriptions.grantOrExtend(
          householdId,
          grant,
          'payment',
        );

        await this.audit.record(householdId, {
          action: 'subscription.activated',
          entityType: 'household_subscription',
          entityId: householdId,
          details: {
            planCode,
            provider: 'revenuecat',
            store: event.store ?? null,
            productId: event.product_id ?? null,
            eventType: event.type ?? null,
            addedDays: result.addedDays,
            stacked: result.stacked,
          },
        });
      },
    );
  }

  /**
   * A refund is recorded, never acted on: deciding WHICH days to remove from a
   * stacked period can take away time somebody owns. A person decides.
   */
  private recordRevocation(event: RevenuecatEvent): RevenuecatOutcome {
    this.logger.warn(
      `RevenueCat ${event.type} for subscriber ${event.app_user_id ?? '(none)'} — ` +
        `product ${event.product_id ?? '(none)'}, txn ${transactionKeyOf(event) ?? '(none)'}. ` +
        'Entitlement left untouched; review by hand.',
    );
    return 'revocation_logged';
  }
}
