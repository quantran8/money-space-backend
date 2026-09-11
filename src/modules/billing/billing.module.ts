import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { BillingExpiryCron } from './billing-expiry.cron';
import { EntitlementController } from './entitlement.controller';
import { EntitlementService } from './entitlement.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsWebhookController } from './payments-webhook.controller';
import { PayosGateway } from './gateways/payos.gateway';
import { PAYMENT_GATEWAY } from './gateways/payment-gateway.interface';
import { PlansController } from './plans.controller';
import { RedeemController } from './redeem.controller';
import { RevenuecatController } from './revenuecat.controller';
import { RevenuecatService } from './revenuecat.service';
import { RevenuecatWebhookController } from './revenuecat-webhook.controller';
import { RedeemService } from './redeem.service';
import { SubscriptionService } from './subscription.service';
import { WhatIfUsageService } from './whatif-usage.service';
import { BILLING_REPOSITORY } from './repositories/billing.repository.interface';
import { PrismaBillingRepository } from './repositories/prisma-billing.repository';

/**
 * Subscriptions, entitlement and — from Phase 2 — redeem codes and payments.
 *
 * Named `billing` rather than `subscription` because it will hold all three.
 * It deliberately imports nothing but `CommonModule`: the guard that enforces
 * entitlement (Phase 3) lives in `AuthModule`, so a dependency the other way
 * would close a cycle.
 */
@Module({
  imports: [CommonModule],
  controllers: [
    EntitlementController,
    PlansController,
    RedeemController,
    PaymentsController,
    PaymentsWebhookController,
    RevenuecatController,
    RevenuecatWebhookController,
  ],
  providers: [
    EntitlementService,
    SubscriptionService,
    // The 09:00 sweep that ends lapsed plans and unpaid checkouts.
    BillingExpiryCron,
    RedeemService,
    WhatIfUsageService,
    PaymentsService,
    // In-app purchase. Not behind PAYMENT_GATEWAY: that token is for gateways we
    // ASK to create a checkout, and a store purchase is only ever reported to
    // us after the fact — there is no link to create and nothing to cancel.
    RevenuecatService,
    // Behind a token so adding VNPay later — once a business licence and its
    // 1.1-2.2% are worth paying — is one new file rather than an edit through
    // PaymentsService.
    {
      provide: PAYMENT_GATEWAY,
      useClass: PayosGateway,
    },
    {
      provide: BILLING_REPOSITORY,
      useClass: PrismaBillingRepository,
    },
  ],
  exports: [
    EntitlementService,
    SubscriptionService,
    WhatIfUsageService,
    PaymentsService,
    RevenuecatService,
    BillingExpiryCron,
  ],
})
export class BillingModule {}
