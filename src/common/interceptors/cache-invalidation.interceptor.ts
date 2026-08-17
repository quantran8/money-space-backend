import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { tap } from 'rxjs/operators';
import { CacheInvalidator } from '../cache/cache-invalidator.service';
import { NO_CACHE_INVALIDATION } from '../cache/no-cache-invalidation.decorator';

/** Methods that can change household state. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Drops a household's cached views after any successful mutating request.
 *
 * Applied globally rather than per-service on purpose. Invalidation hooked into
 * each of the ~25 individual write sites would silently rot: every new endpoint
 * becomes a chance to forget one, and a forgotten hook serves stale money
 * figures until the TTL expires — the kind of bug that surfaces as "tôi vừa
 * sửa mà số chưa đổi". Keying off the HTTP method and the `:householdId` route
 * param instead means a new endpoint is covered the moment it is registered.
 *
 * Every household-scoped controller mounts under
 * `api/households/:householdId/...`, so the param is always present on the
 * routes that matter.
 *
 * Fires only on success — `tap`'s next handler does not run when the observable
 * errors, so a failed (rolled-back) write leaves the cache untouched.
 */
@Injectable()
export class CacheInvalidationInterceptor implements NestInterceptor {
  constructor(
    private readonly invalidator: CacheInvalidator,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    if (!MUTATING_METHODS.has(request.method)) return next.handle();

    // Opt-out for handlers that are POST only because they take a body.
    const readOnly = this.reflector.getAllAndOverride<boolean>(
      NO_CACHE_INVALIDATION,
      [context.getHandler(), context.getClass()],
    );
    if (readOnly) return next.handle();

    const householdId = (request.params as Record<string, string | undefined>)
      ?.householdId;
    if (!householdId) return next.handle();

    return next.handle().pipe(
      tap(() => {
        // Fire-and-forget: the write already succeeded and the client is
        // waiting. `invalidateHousehold` never throws, and the `void`+catch
        // keeps a rejected promise from reaching the process-level guard.
        void this.invalidator
          .invalidateHousehold(householdId)
          .catch(() => undefined);
      }),
    );
  }
}
