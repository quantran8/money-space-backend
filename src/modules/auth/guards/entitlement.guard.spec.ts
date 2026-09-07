import { EntitlementGuard } from './entitlement.guard';
import { PremiumRequiredException } from '../../billing/entitlement.errors';
import { REQUIRE_PREMIUM_KEY } from '../decorators/require-premium.decorator';
import {
  freeEntitlement,
  premiumEntitlement,
} from '../../billing/test-support/entitlement.fixture';
import type { PremiumFeature } from '../../billing/entities/entitlement.entity';

/**
 * The guard is registered GLOBALLY, so the property that matters most is what
 * it does on the routes that carry no decorator — which is almost all of them.
 */
describe('EntitlementGuard', () => {
  function makeContext(membership: { householdId: string } | undefined) {
    return {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ membership }) }),
    } as never;
  }

  function makeGuard(
    feature: PremiumFeature | undefined,
    forHousehold = jest.fn(async () => premiumEntitlement()),
  ) {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) =>
        key === REQUIRE_PREMIUM_KEY ? feature : undefined,
      ),
    } as never;
    const guard = new EntitlementGuard(reflector, { forHousehold } as never);
    return { guard, forHousehold };
  }

  it('allows an undecorated route WITHOUT resolving an entitlement at all', async () => {
    const { guard, forHousehold } = makeGuard(undefined);

    await expect(guard.canActivate(makeContext({ householdId: 'hh-1' }))).resolves.toBe(
      true,
    );
    // The whole reason this is safe to register globally: no cache read, no
    // database read, nothing but one Reflector lookup.
    expect(forHousehold).not.toHaveBeenCalled();
  });

  it('lets a premium household through a gated route', async () => {
    const { guard } = makeGuard('forecast_horizon_extended');

    await expect(
      guard.canActivate(makeContext({ householdId: 'hh-1' })),
    ).resolves.toBe(true);
  });

  it('refuses a free household with 402 and the reason for the paywall', async () => {
    const { guard } = makeGuard(
      'forecast_horizon_extended',
      jest.fn(async () => freeEntitlement()),
    );

    await expect(
      guard.canActivate(makeContext({ householdId: 'hh-1' })),
    ).rejects.toBeInstanceOf(PremiumRequiredException);

    try {
      await guard.canActivate(makeContext({ householdId: 'hh-1' }));
    } catch (error) {
      const body = (error as PremiumRequiredException).getResponse() as {
        premium: { reason: string };
      };
      // 402, deliberately not 403: 403 already means "not a member of this
      // household", and the client could not tell the two apart.
      expect((error as PremiumRequiredException).getStatus()).toBe(402);
      expect(body.premium.reason).toBe('forecast_horizon');
    }
  });

  it('allows a decorated route that is not household-scoped', async () => {
    // Nothing to resolve an entitlement from; the auth guard has already run,
    // so this is a mis-decorated route rather than an authorization hole.
    const { guard } = makeGuard('export_data');
    await expect(guard.canActivate(makeContext(undefined))).resolves.toBe(true);
  });
});
