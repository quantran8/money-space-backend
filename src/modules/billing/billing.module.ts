import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { EntitlementController } from './entitlement.controller';
import { EntitlementService } from './entitlement.service';
import { PlansController } from './plans.controller';
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
  controllers: [EntitlementController, PlansController],
  providers: [
    EntitlementService,
    {
      provide: BILLING_REPOSITORY,
      useClass: PrismaBillingRepository,
    },
  ],
  exports: [EntitlementService],
})
export class BillingModule {}
