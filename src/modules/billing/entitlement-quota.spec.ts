import { EntitlementService } from './entitlement.service';
import { PremiumRequiredException } from './entitlement.errors';
import { freeEntitlement, premiumEntitlement } from './test-support/entitlement.fixture';

/**
 * `assertQuota` — where every COUNTED limit is enforced.
 *
 * It lives in the service rather than the guard because a guard cannot count
 * without a second query, and the service has already made the query it needs.
 */
describe('EntitlementService.assertQuota', () => {
  const service = new EntitlementService(
    {} as never,
    {} as never,
    {} as never,
  );

  it('allows a free household below its ceiling', () => {
    expect(() =>
      service.assertQuota(freeEntitlement(), 'goals', 1, 'goal_quota'),
    ).not.toThrow();
  });

  it('refuses AT the ceiling, not past it', () => {
    // Two goals used, two allowed: the THIRD is what is being asked for, so
    // this must refuse rather than wait for `used > limit`.
    expect(() =>
      service.assertQuota(freeEntitlement(), 'goals', 2, 'goal_quota'),
    ).toThrow(PremiumRequiredException);
  });

  it('never refuses an unlimited plan, whatever the count', () => {
    // `null` means unlimited, never zero — the distinction the whole limits
    // shape rests on.
    expect(() =>
      service.assertQuota(premiumEntitlement(), 'goals', 9_999, 'goal_quota'),
    ).not.toThrow();
  });

  it('carries the limit, the usage and the reason to the client', () => {
    try {
      service.assertQuota(freeEntitlement(), 'whatIfPerMonth', 5, 'whatif_quota');
      throw new Error('expected a 402');
    } catch (error) {
      const body = (error as PremiumRequiredException).getResponse() as {
        message: string;
        premium: { reason: string; limit: number; used: number };
      };
      expect((error as PremiumRequiredException).getStatus()).toBe(402);
      // A CODE, never a sentence: the client owns all copy.
      expect(body.message).toBe('premium_required');
      expect(body.premium).toMatchObject({
        reason: 'whatif_quota',
        limit: 5,
        used: 5,
      });
    }
  });
});
