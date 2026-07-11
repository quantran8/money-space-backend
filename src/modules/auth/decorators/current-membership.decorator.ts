import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type {
  HouseholdMembership,
  RequestWithMembership,
} from '../guards/household-access.guard';

/**
 * The caller's membership in the route's household (role + effective
 * permission), attached by `HouseholdAccessGuard`. Undefined only on routes
 * that guard did not run on.
 */
export const CurrentMembership = createParamDecorator(
  (
    _data: unknown,
    context: ExecutionContext,
  ): HouseholdMembership | undefined => {
    const request = context.switchToHttp().getRequest<RequestWithMembership>();
    return request.membership;
  },
);
