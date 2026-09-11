import { Body, Controller, Headers, HttpCode, Logger, Post } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { NoCacheInvalidation } from '../../common/cache/no-cache-invalidation.decorator';
import { RawResponse } from '../../common/interceptors/raw-response.decorator';
import { billingConfig } from '../../config/billing.config';
import { verifyWebhookAuth } from './domain/revenuecat-auth';
import { RevenuecatService } from './revenuecat.service';
import type { RevenuecatWebhookBody } from './domain/revenuecat-event';

/**
 * RevenueCat calling us back. Same three decorators as the PayOS webhook, for
 * the same reasons — see that controller.
 *
 * Its `Authorization` secret is WEAKER than an HMAC: it proves the caller knows
 * the secret, not that the body is unaltered, so the service checks the payload
 * rather than obeying it. **Answers 200 to everything it understands.**
 * See `memory/billing-and-entitlement.md`.
 */
@Controller('billing/webhooks/revenuecat')
export class RevenuecatWebhookController {
  private readonly logger = new Logger(RevenuecatWebhookController.name);

  constructor(private readonly revenuecat: RevenuecatService) {}

  @Public()
  @NoCacheInvalidation()
  @RawResponse()
  @HttpCode(200)
  @Post()
  async handle(
    @Body() body: RevenuecatWebhookBody,
    @Headers('authorization') authorization?: string,
  ) {
    if (
      !verifyWebhookAuth(authorization, billingConfig.revenuecatWebhookSecret)
    ) {
      // 200, and nothing about WHY: free information for someone probing.
      this.logger.warn('RevenueCat webhook rejected: authorization did not match');
      return { received: true };
    }

    const outcome = await this.revenuecat.handleWebhook(body);
    this.logger.log(`RevenueCat webhook handled: ${outcome}`);

    return { received: true };
  }
}
