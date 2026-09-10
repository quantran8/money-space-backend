import { Controller, Get, Param, Post } from '@nestjs/common';
import { billingConfig } from '../../config/billing.config';
import { EntitlementService } from './entitlement.service';
import { SubscriptionService } from './subscription.service';

@Controller('households/:householdId')
export class EntitlementController {
  constructor(
    private readonly entitlements: EntitlementService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  /**
   * What this household's plan currently allows, including `limits` in full.
   *
   * The limits ship in the response on purpose: the clients render every
   * ceiling from this answer and hardcode no number, so changing what Free
   * includes is a backend edit and needs no app-store release.
   */
  @Get('entitlement')
  getEntitlement(@Param('householdId') householdId: string) {
    return this.entitlements.forHouseholdWithUsage(householdId);
  }

  /**
   * Start the free trial. The paywall's own action — any member may take it,
   * like redeeming a code. See memory/billing-and-entitlement.md.
   */
  @Post('entitlement/trial')
  startTrial(@Param('householdId') householdId: string) {
    return this.subscriptions.startTrial(householdId, billingConfig.trialDays);
  }
}
