import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { NoCacheInvalidation } from '../../../common/cache/no-cache-invalidation.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { parseIngestBody } from '../dto/ingest-bank-notification.dto';
import { BankIngestTokenGuard } from '../guards/bank-ingest-token.guard';
import type { RequestWithBankIngest } from '../guards/bank-ingest-token.guard';
import { BankIngestService } from '../services/bank-ingest.service';

/**
 * iOS Shortcuts entry point. `@Public()` skips the Supabase JWT guard; the
 * device token guard authenticates instead. 202 = received, not posted.
 */
@Controller('bank-notifications')
export class BankIngestController {
  constructor(private readonly ingest: BankIngestService) {}

  @Public()
  @NoCacheInvalidation()
  @UseGuards(BankIngestTokenGuard)
  @HttpCode(202)
  @Post('ingest')
  async handle(
    @Req() request: RequestWithBankIngest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const dto = parseIngestBody(body);
    // The guard always sets this; it narrows the type.
    const ctx = request.bankIngest!;
    const outcome = await this.ingest.ingest(ctx, dto);
    if (outcome.replayed) {
      response.status(200);
      return {
        eventId: outcome.eventId,
        status: 'DUPLICATE',
        currentStatus: outcome.status,
      };
    }
    return { eventId: outcome.eventId, status: outcome.status };
  }
}
