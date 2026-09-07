import { PLAN_CATALOG } from './plan-catalog';
import {
  STORE_PRODUCTS,
  durationDaysForProduct,
  planCodeForProduct,
} from './store-products';

describe('store products', () => {
  it('maps each product to a plan we actually sell', () => {
    for (const planCode of Object.values(STORE_PRODUCTS)) {
      expect(PLAN_CATALOG[planCode]).toBeDefined();
    }
  });

  it('resolves a product to its plan', () => {
    expect(planCodeForProduct('oursight_premium_yearly')).toBe('premium_yearly');
    expect(planCodeForProduct('oursight_premium_lifetime')).toBe('premium_lifetime');
  });

  /** Play appends the base plan id in some configurations. */
  it('ignores an Android base-plan suffix', () => {
    expect(planCodeForProduct('oursight_premium_yearly:p1y')).toBe('premium_yearly');
  });

  /**
   * `null`, not a throw: an unrecognised product is our configuration being
   * wrong, and the webhook must still answer 200 — retrying cannot fix it.
   */
  it('is null for a product we do not know', () => {
    expect(planCodeForProduct('some_other_app_product')).toBeNull();
    expect(planCodeForProduct(undefined)).toBeNull();
    expect(planCodeForProduct('')).toBeNull();
  });

  it('reads duration from the plan catalog rather than restating it', () => {
    expect(durationDaysForProduct('oursight_premium_monthly')).toBe(
      PLAN_CATALOG.premium_monthly.durationDays,
    );
    // Lifetime is null, and that is distinct from "unknown product".
    expect(durationDaysForProduct('oursight_premium_lifetime')).toBeNull();
    expect(durationDaysForProduct('nope')).toBeUndefined();
  });
});
