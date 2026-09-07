import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EntitlementService } from '../../billing/entitlement.service';
import { PremiumRequiredException } from '../../billing/entitlement.errors';
import { hasFeature } from '../../billing/constants/plan-limits';
import { REQUIRE_PREMIUM_KEY } from '../decorators/require-premium.decorator';
import type { PremiumFeature } from '../../billing/entities/entitlement.entity';
import type { RequestWithMembership } from './household-access.guard';

/**
 * Enforces the boolean premium features.
 *
 * Registered as the THIRD global guard, after `HouseholdAccessGuard`: it reads
 * `request.membership`, which that guard is what populates. Running earlier
 * would mean re-resolving the household, and would also let a non-member learn
 * a household's plan.
 *
 * **It returns `true` immediately when a route carries no decorator** — no
 * cache read, no database read, no entitlement resolution at all. That is the
 * property that makes it safe to register globally rather than route by route:
 * the overwhelming majority of requests pay one `Reflector` lookup for it.
 *
 * Counted quotas are NOT here. See `RequirePremium` for why.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<PremiumFeature | undefined>(
      REQUIRE_PREMIUM_KEY,
      [context.getHandler(), context.getClass()],
    );
    // The hot path: nothing to enforce, so nothing is loaded.
    if (!feature) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithMembership>();
    const householdId = request.membership?.householdId;
    // A decorated route that is not household-scoped has nothing to resolve an
    // entitlement from. `HouseholdAccessGuard` has already authenticated, so
    // letting it through is not an authorization hole — it is a route that
    // should not have carried the decorator.
    if (!householdId) {
      return true;
    }

    const entitlement = await this.entitlements.forHousehold(householdId);
    if (hasFeature(entitlement.limits, feature)) {
      return true;
    }

    throw new PremiumRequiredException(reasonFor(feature), entitlement);
  }
}

/** Which paywall the client should open for each feature. */
function reasonFor(feature: PremiumFeature) {
  switch (feature) {
    case 'forecast_horizon_extended':
      return 'forecast_horizon' as const;
    case 'history_full':
      return 'history' as const;
    case 'export_data':
      return 'export' as const;
  }
}
