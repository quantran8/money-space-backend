import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { buildPlanOffers } from './domain/plan-pricing';

@Controller('billing')
export class PlansController {
  /**
   * What is for sale, at today's prices.
   *
   * `@Public()` because the landing page quotes these before anyone signs in,
   * and there is nothing household-specific in the answer. Not household-scoped
   * either, so the guards fall through.
   *
   * Every price the product displays comes from here — no client holds a
   * hardcoded amount, which is what makes a discount campaign an env change
   * rather than a release.
   */
  @Public()
  @Get('plans')
  listPlans() {
    const items = buildPlanOffers(new Date()).filter((plan) => plan.available);
    return { items, total: items.length };
  }
}
