import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  CodedException,
  UnauthenticatedException,
} from '../../../common/errors/coded.exceptions';
import { bankSyncConfig } from '../../../config/bank-sync.config';
import { hasFeature } from '../../billing/constants/plan-limits';
import { PremiumRequiredException } from '../../billing/entitlement.errors';
import { EntitlementService } from '../../billing/entitlement.service';
import { bearerFrom } from '../domain/ingest-token';
import { SlidingWindowLimiter } from '../domain/rate-limiter';
import { INGEST_MAX_BYTES } from '../dto/ingest-bank-notification.dto';
import type { BankIngestContext } from '../entities/bank-sync.entity';
import { BankCredentialsService } from '../services/bank-credentials.service';

export interface RequestWithBankIngest extends Request {
  rawBody?: Buffer;
  bankIngest?: BankIngestContext;
}

/** Device-token auth for the Shortcuts endpoint. See memory/bank-sync.md. */
@Injectable()
export class BankIngestTokenGuard implements CanActivate {
  private readonly limiter = new SlidingWindowLimiter(
    () => bankSyncConfig.ratePerMinute,
    60_000,
  );

  constructor(
    private readonly credentials: BankCredentialsService,
    private readonly entitlements: EntitlementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithBankIngest>();

    if ((request.rawBody?.length ?? 0) > INGEST_MAX_BYTES) {
      throw new PayloadTooLargeException('payload_too_large');
    }
    if (!bankSyncConfig.configured) {
      throw new ServiceUnavailableException('Bank sync is not configured.');
    }

    const token = bearerFrom(request.headers.authorization);
    const ctx = token ? await this.credentials.authenticate(token) : null;
    if (!ctx) {
      throw new UnauthenticatedException('Invalid ingest token');
    }

    if (!this.limiter.allow(ctx.credentialId)) {
      throw new CodedException(
        'rate_limited',
        'Ingest rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const entitlement = await this.entitlements.forHousehold(ctx.householdId);
    if (!hasFeature(entitlement.limits, 'bank_sync')) {
      throw new PremiumRequiredException('bank_sync', entitlement);
    }

    request.bankIngest = ctx;
    return true;
  }
}
