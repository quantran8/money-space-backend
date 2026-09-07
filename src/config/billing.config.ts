/**
 * Billing configuration.
 *
 * Prices themselves are constants in `modules/billing/constants/plan-catalog.ts`
 * — changing one deserves a code review. What lives here is everything that is
 * a *campaign*: discounts and whether the lifetime plan is on sale. Those need
 * to change on a weekend without a deploy.
 *
 * Every field is a GETTER, not a value. `ConfigModule.forRoot()` populates
 * `process.env` from `.env` while `AppModule`'s imports array is evaluated —
 * which is after this module has been imported. Plain fields would therefore
 * capture whatever the shell exported and ignore `.env` entirely, which is
 * exactly the bug that made a configured discount silently do nothing.
 */
function percent(raw: string | undefined): number {
  const value = Number(raw ?? 0);
  // A malformed env var must not silently make things free.
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 100);
}

export const billingConfig = {
  /**
   * Whether the lifetime plan can still be bought.
   *
   * Turning it off removes it from `GET /billing/plans` and refuses new orders
   * for it. Households that already bought it keep it forever — this switch
   * stops sales, it never revokes. Worth watching: market-data API cost runs
   * indefinitely against a single payment, so capping sales is what this is for.
   */
  get lifetimeEnabled(): boolean {
    return process.env.BILLING_LIFETIME_ENABLED !== 'false';
  },

  /**
   * Per-plan discount, in percent. 0 = full price.
   * e.g. `BILLING_DISCOUNT_YEARLY_PERCENT=20` → 299.000đ becomes 239.000đ.
   */
  get discountPercent(): Record<
    'premium_monthly' | 'premium_yearly' | 'premium_lifetime',
    number
  > {
    return {
      premium_monthly: percent(process.env.BILLING_DISCOUNT_MONTHLY_PERCENT),
      premium_yearly: percent(process.env.BILLING_DISCOUNT_YEARLY_PERCENT),
      premium_lifetime: percent(process.env.BILLING_DISCOUNT_LIFETIME_PERCENT),
    };
  },

  /** Badge text for the campaign, e.g. "Tết 2027". Empty → no badge. */
  get discountLabel(): string {
    return process.env.BILLING_DISCOUNT_LABEL ?? '';
  },

  /**
   * Campaign window, ISO dates. Outside it every discount is 0, so a promotion
   * can be scheduled and expires on its own rather than needing to be switched
   * off by hand. Both empty → the discounts above always apply.
   */
  get discountStartsAt(): string {
    return process.env.BILLING_DISCOUNT_STARTS_AT ?? '';
  },
  get discountEndsAt(): string {
    return process.env.BILLING_DISCOUNT_ENDS_AT ?? '';
  },

  /** How long a household is given Premium on signup. */
  get trialDays(): number {
    return Number(process.env.BILLING_TRIAL_DAYS ?? 14);
  },
};
