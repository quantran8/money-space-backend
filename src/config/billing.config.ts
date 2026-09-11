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

  /**
   * PayOS credentials.
   *
   * Three separate secrets with three different jobs: the client id and api key
   * authenticate US to PayOS when creating a link, while the CHECKSUM key
   * verifies that a webhook came from PayOS. Only the last one is a signing
   * secret, and leaking it means anyone can grant themselves Premium — it is
   * never logged and never sent to a client.
   *
   * All default to empty. `payosConfigured` is what every caller checks, so a
   * deploy without them refuses to create orders rather than failing halfway
   * through a checkout.
   */
  get payosClientId(): string {
    return process.env.PAYOS_CLIENT_ID ?? '';
  },
  get payosApiKey(): string {
    return process.env.PAYOS_API_KEY ?? '';
  },
  get payosChecksumKey(): string {
    return process.env.PAYOS_CHECKSUM_KEY ?? '';
  },

  /** Where PayOS sends the browser back to. */
  get payosReturnUrl(): string {
    return process.env.PAYOS_RETURN_URL ?? '';
  },
  get payosCancelUrl(): string {
    return process.env.PAYOS_CANCEL_URL ?? '';
  },

  /**
   * Whether payment can be offered at all. Checked before an order is created
   * so a misconfigured deploy fails at the button rather than at the bank.
   */
  get payosConfigured(): boolean {
    return Boolean(
      this.payosClientId && this.payosApiKey && this.payosChecksumKey,
    );
  },

  /**
   * How long a checkout link stays open, in minutes. Short on purpose: an
   * abandoned order holds its `orderCode` and its price, and a household that
   * comes back tomorrow should get today's price, not last week's.
   */
  get payosOrderTtlMinutes(): number {
    return Number(process.env.PAYOS_ORDER_TTL_MINUTES ?? 30);
  },

  /**
   * The shared secret in RevenueCat's `Authorization` header. Never logged,
   * never sent to a client. Empty refuses every delivery — it fails closed.
   */
  get revenuecatWebhookSecret(): string {
    return process.env.REVENUECAT_WEBHOOK_SECRET ?? '';
  },

  /**
   * The entitlement id configured in RevenueCat, checked against the event so a
   * product attached to the wrong one cannot hand out Premium.
   */
  get revenuecatEntitlementId(): string {
    return process.env.REVENUECAT_ENTITLEMENT_ID ?? 'premium';
  },

  /** A sandbox receipt is free money — on for TestFlight, off in production. */
  get revenuecatAllowSandbox(): boolean {
    return process.env.REVENUECAT_ALLOW_SANDBOX === 'true';
  },

  /** Whether in-app purchase can be offered at all. The mobile paywall asks. */
  get revenuecatConfigured(): boolean {
    return Boolean(this.revenuecatWebhookSecret);
  },
};
