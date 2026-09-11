import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { NoCacheInvalidation } from '../../common/cache/no-cache-invalidation.decorator';
import { RawResponse } from '../../common/interceptors/raw-response.decorator';
import { PaymentsService, type PayosWebhookBody } from './payments.service';

/**
 * PayOS calling us back.
 *
 * Three decorators, each load-bearing:
 *
 * - `@Public()` — PayOS has no bearer token. The request is authenticated by
 *   its HMAC signature instead, which is strictly better here: a token would
 *   only prove someone had the token, while the signature proves the BODY is
 *   unaltered.
 * - `@NoCacheInvalidation()` — the household's cache is dropped inside the
 *   settle transaction, precisely and only when a grant actually happened. The
 *   blanket POST invalidation would also fire for a forged signature.
 * - `@RawResponse()` — PayOS decides what an acknowledgement looks like; our
 *   `{ success, data }` envelope would nest the fields it checks one level too
 *   deep, so every delivery would read as failed and be retried forever.
 *
 * **It answers 200 to everything it understands**, including a forged
 * signature and an unknown order. Those are settled outcomes: retrying them
 * cannot make them succeed, and a 5xx would have PayOS retry forever. Only a
 * genuinely transient failure — the database being down — is allowed to throw,
 * because that one IS worth retrying.
 */
@Controller('billing/webhooks/payos')
export class PaymentsWebhookController {
  private readonly logger = new Logger(PaymentsWebhookController.name);

  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @NoCacheInvalidation()
  @RawResponse()
  @HttpCode(200)
  @Post()
  async handle(@Body() body: PayosWebhookBody) {
    const outcome = await this.payments.handleWebhook(body);

    // The outcome goes to the log, never to PayOS. Telling a caller that its
    // signature failed, or that an order is unknown, is free information for
    // someone probing the endpoint.
    this.logger.log(`PayOS webhook handled: ${outcome}`);

    // The shape PayOS expects for an acknowledgement.
    return { success: true };
  }
}
