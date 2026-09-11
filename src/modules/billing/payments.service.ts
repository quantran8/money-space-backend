import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { uuidv7 } from '../../common/utils/uuid';
import { CacheInvalidator } from '../../common/cache/cache-invalidator.service';
import { AuditService } from '../../common/audit/audit.service';
import { billingConfig } from '../../config/billing.config';
import { PLAN_CATALOG, isPlanCode, type PlanCode } from './constants/plan-catalog';
import { buildPlanOffers } from './domain/plan-pricing';
import { generateOrderCode, PAYMENT_DESCRIPTION } from './domain/order-code';
import { verifySignature } from './domain/payos-signature';
import { SubscriptionService } from './subscription.service';
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
} from './gateways/payment-gateway.interface';
import {
  BILLING_REPOSITORY,
  type BillingRepository,
} from './repositories/billing.repository.interface';
import { isUniqueViolation } from '../../common/repositories/prisma-errors';
import { AnalyticsService } from '../../common/analytics/analytics.service';
import { isPaywallReason } from '../../common/analytics/paywall-reason';

/** PayOS's webhook body. `data` is what carries the signature. */
export interface PayosWebhookBody {
  code?: string;
  desc?: string;
  success?: boolean;
  data?: Record<string, unknown>;
  signature?: string;
}

/**
 * What the webhook did, for the log. It is never returned to PayOS — the
 * webhook's response says only that it was received.
 */
type WebhookOutcome =
  | 'granted'
  | 'already_handled'
  | 'bad_signature'
  | 'unknown_order'
  | 'underpaid'
  | 'test_ping'
  | 'ignored';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(BILLING_REPOSITORY)
    private readonly billingRepository: BillingRepository,
    @Inject(PAYMENT_GATEWAY)
    private readonly gateway: PaymentGateway,
    private readonly subscriptions: SubscriptionService,
    private readonly cacheInvalidator: CacheInvalidator,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
  ) {}

  /**
   * Open a checkout.
   *
   * The price is taken from `buildPlanOffers` — never from the request. A
   * client that could name its own amount could buy a lifetime plan for 1.000đ,
   * and the campaign discount has to be resolved server-side anyway.
   */
  async createOrder(
    householdId: string,
    userId: string,
    planCode: string,
    rawFromReason?: string,
  ) {
    // Narrowed to the eight reasons a 402 can carry; anything else is dropped.
    const fromReason = isPaywallReason(rawFromReason) ? rawFromReason : null;
    if (!billingConfig.payosConfigured) {
      // Refused here rather than at the gateway, so the button fails with a
      // clear reason instead of a 503 halfway through a checkout.
      throw new BadRequestException('payments_unavailable');
    }
    if (!isPlanCode(planCode)) {
      throw new BadRequestException('unknown_plan');
    }

    const offer = buildPlanOffers(new Date()).find(
      (candidate) => candidate.planCode === planCode,
    );
    // `available` follows BILLING_LIFETIME_ENABLED: a plan switched off must
    // not be buyable through a stale page that still shows its button.
    if (!offer || !offer.available) {
      throw new BadRequestException('plan_unavailable');
    }

    const orderCode = BigInt(generateOrderCode());
    const expiresAt = new Date(
      Date.now() + billingConfig.payosOrderTtlMinutes * 60 * 1000,
    );

    try {
      await this.billingRepository.insertPaymentOrder({
        id: uuidv7(),
        householdId,
        createdById: userId,
        orderCode,
        planCode,
        amountOriginal: offer.amountOriginal,
        discountAmount: offer.discountAmount,
        amount: offer.amount,
        durationDays: PLAN_CATALOG[planCode as PlanCode].durationDays,
        expiresAt,
        // Frozen on the order because the webhook has no request context: by
        // the time PayOS calls back, the paywall that prompted this is gone.
        fromReason,
      });
    } catch (error) {
      // Two checkouts in the same second drew the same code. The unique index
      // is what settles it; the household simply retries.
      if (isUniqueViolation(error)) {
        throw new BadRequestException('order_collision_retry');
      }
      throw error;
    }

    // The row exists BEFORE the gateway is called. If PayOS answers and we
    // crash before writing, the order is still there to reconcile against —
    // whereas a link created with no local row is money we cannot attribute.
    const link = await this.gateway.createPaymentLink({
      orderCode: Number(orderCode),
      amount: offer.amount,
      // Capped at 9 characters by PayOS for accounts not linked to it.
      description: PAYMENT_DESCRIPTION,
      returnUrl: billingConfig.payosReturnUrl,
      cancelUrl: billingConfig.payosCancelUrl,
      expiredAt: Math.floor(expiresAt.getTime() / 1000),
    });

    await this.billingRepository.attachCheckout(orderCode, {
      checkoutUrl: link.checkoutUrl,
      providerOrderId: link.paymentLinkId,
    });

    // `price_vnd` is OUR list price, not the household's money — the one
    // figure the catalog's ban carves an exception for.
    this.analytics.capture(
      householdId,
      'checkout_created',
      {
        plan_code: planCode,
        price_vnd: offer.amount,
        discount_percent: offer.discountPercent,
        from_reason: fromReason,
      },
      userId,
    );

    return {
      orderCode: orderCode.toString(),
      checkoutUrl: link.checkoutUrl,
      amount: offer.amount,
      planCode,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Where one order stands. The return page polls this.
   *
   * It reads OUR row, not the gateway: the webhook is what grants the period,
   * so a status here that ran ahead of it would tell a household they had
   * Premium a moment before they did.
   */
  async getOrderStatus(householdId: string, orderCode: string) {
    const order = await this.findOwnOrder(householdId, orderCode);

    return {
      // Non-null: this row was found BY its order code, so it has one.
      orderCode: String(order.orderCode),
      status: order.status,
      planCode: order.planCode,
      amount: order.amount,
      paidAt: order.paidAt?.toISOString() ?? null,
    };
  }

  async listOrders(householdId: string) {
    const orders = await this.billingRepository.listPaymentOrders(
      householdId,
      20,
    );

    return {
      items: orders.map((order) => ({
        // An in-app purchase has no order code — it was never handed to PayOS.
        // The store's transaction id stands in, so every row in the history has
        // something a household can quote to support.
        orderCode: order.orderCode ? String(order.orderCode) : (order.providerTxnId ?? order.id),
        status: order.status,
        planCode: order.planCode,
        amount: order.amount,
        createdAt: order.createdAt.toISOString(),
        paidAt: order.paidAt?.toISOString() ?? null,
        // Which route paid for it. The history says "App Store" rather than
        // showing a bank transfer that never happened.
        provider: order.provider ?? 'payos',
        store: order.store ?? null,
      })),
      total: orders.length,
    };
  }

  /** Walking away from a checkout. Only ever closes a pending order. */
  async cancelOrder(householdId: string, orderCode: string) {
    const order = await this.findOwnOrder(householdId, orderCode);
    if (order.status !== 'pending') {
      return { cancelled: false, status: order.status };
    }

    // The local row first: if PayOS is unreachable, an order nobody can pay
    // for is better than one we believe is dead while the link still works.
    await this.billingRepository.markPaymentOrderClosed(
      order.orderCode!,
      'cancelled',
    );
    try {
      await this.gateway.cancelPaymentLink(Number(order.orderCode));
    } catch (error) {
      this.logger.warn(
        `Order ${orderCode} closed locally but PayOS cancel failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return { cancelled: true, status: 'cancelled' as const };
  }

  /**
   * The webhook.
   *
   * **This never throws for a business reason.** Every outcome that is settled
   * — a forged signature, an unknown order, a replay — returns normally, and
   * the controller answers 200. A permanent failure answered with a 5xx is one
   * PayOS retries forever, and the retries would arrive at a system that can
   * never succeed. Genuine transient failures (the database is down) DO throw,
   * on purpose: those are worth retrying.
   */
  async handleWebhook(body: PayosWebhookBody): Promise<WebhookOutcome> {
    // PayOS calls the endpoint once to verify it when the URL is registered.
    // That ping carries no real order and must not be treated as a failure.
    if (!body?.data || Object.keys(body.data).length === 0) {
      this.logger.log('PayOS webhook verification ping received');
      return 'test_ping';
    }

    if (
      !verifySignature(
        body.data,
        body.signature,
        billingConfig.payosChecksumKey,
      )
    ) {
      // Deliberately not an error response: an attacker learns nothing, and
      // PayOS is not asked to retry something that will never verify.
      this.logger.warn('PayOS webhook rejected: signature did not verify');
      return 'bad_signature';
    }

    const orderCodeRaw = body.data.orderCode;
    if (orderCodeRaw === undefined || orderCodeRaw === null) {
      return 'test_ping';
    }

    let orderCode: bigint;
    try {
      orderCode = BigInt(String(orderCodeRaw));
    } catch {
      this.logger.warn(`PayOS webhook carried an unusable orderCode`);
      return 'ignored';
    }

    const order = await this.billingRepository.findPaymentOrderByCode(orderCode);
    if (!order) {
      // A verified signature on an order we have never heard of. Logged rather
      // than retried — it will not become known.
      this.logger.warn(`PayOS webhook for unknown order ${orderCode}`);
      return 'unknown_order';
    }

    // Not `!== 'pending'` alone: a replay of an order we already settled is the
    // expected case, and must be answered calmly.
    if (order.status === 'paid') {
      this.logger.log(`PayOS webhook for order ${orderCode} already handled`);
      return 'already_handled';
    }

    const paidAmount = Number(body.data.amount ?? 0);
    if (paidAmount < order.amount) {
      // NOT auto-cancelled. Somebody sent real money; a person decides what
      // happens to it, and `rawPayload` is what they will need to see.
      this.logger.warn(
        `Order ${orderCode} underpaid: ${paidAmount} of ${order.amount}`,
      );
      await this.billingRepository.recordPaymentPayload(orderCode, body);
      return 'underpaid';
    }

    const reference = String(
      body.data.reference ?? body.data.paymentLinkId ?? orderCode,
    );

    try {
      await this.settle(order, reference, body);
    } catch (error) {
      // The unique `provider_txn_id` fired: two deliveries raced and the other
      // one won. That IS the idempotency barrier working.
      if (isUniqueViolation(error)) {
        this.logger.log(
          `PayOS webhook for order ${orderCode} lost the settle race — already handled`,
        );
        return 'already_handled';
      }
      // Anything else is transient (the database is down). Rethrown so the
      // controller answers 500 and PayOS retries — which is what we want here.
      throw error;
    }

    return 'granted';
  }

  /**
   * Mark paid and extend the period **in one transaction**.
   *
   * That is the whole point of doing it here: a household cannot end up in the
   * state "we took the money and granted nothing", because there is no moment
   * between the two writes for a crash to land in.
   */
  private async settle(
    order: {
      orderCode: bigint | null;
      householdId: string;
      planCode: string;
      durationDays: number | null;
      amount: number;
      fromReason?: string | null;
    },
    reference: string,
    body: PayosWebhookBody,
  ): Promise<void> {
    await this.cacheInvalidator.runInTransactionAndInvalidate(
      order.householdId,
      async () => {
        // Barrier 2: `WHERE status = 'pending'`, re-evaluated by Postgres for
        // the second transaction after the first commits. A replay matches no
        // row and this returns false.
        const claimed = await this.billingRepository.markPaymentOrderPaid(
          // Non-null on this path: the order was looked up BY its code.
          order.orderCode!,
          { providerTxnId: reference, paidAt: new Date(), rawPayload: body },
        );
        if (!claimed) return;

        // Barrier 3 lives inside grantOrExtend: it locks the subscription row
        // before reading the expiry, so two grants cannot extend from the same
        // starting point.
        const grant =
          order.durationDays === null
            ? ({ type: 'lifetime' } as const)
            : ({ type: 'duration_days', days: order.durationDays } as const);

        const result = await this.subscriptions.grantOrExtend(
          order.householdId,
          grant,
          'payment',
        );

        await this.audit.record(order.householdId, {
          // No actor: the webhook is PayOS calling us, not a person acting.
          // Attributing it to whoever opened the checkout would be a guess
          // the journal states as fact.
          action: 'subscription.activated',
          entityType: 'household_subscription',
          entityId: order.householdId,
          details: {
            planCode: order.planCode,
            orderCode: String(order.orderCode),
            addedDays: result.addedDays,
            stacked: result.stacked,
          },
        });

        // Inside the transaction callback but after the grant: a settlement
        // event for a payment that rolled back would be revenue we never took.
        // No actor — PayOS called us, nobody pressed anything.
        // `from_reason` comes off the ORDER, not the request: the webhook is
        // PayOS calling us and has no user context at all. Freezing it at
        // checkout is what makes "which wall converted" answerable.
        this.analytics.capture(order.householdId, 'payment_settled', {
          plan_code: order.planCode,
          price_vnd: order.amount,
          provider: 'payos',
          store: null,
          from_reason: isPaywallReason(order.fromReason)
            ? order.fromReason
            : null,
        });
      },
    );
  }

  /** An order, confirmed to belong to this household. */
  private async findOwnOrder(householdId: string, orderCode: string) {
    let parsed: bigint;
    try {
      parsed = BigInt(orderCode);
    } catch {
      throw new NotFoundException('order_not_found');
    }

    const order = await this.billingRepository.findPaymentOrderByCode(parsed);
    // The same 404 for "does not exist" and "belongs to someone else", so an
    // order code cannot be probed for existence across households.
    if (!order || order.householdId !== householdId) {
      throw new NotFoundException('order_not_found');
    }
    return order;
  }
}
