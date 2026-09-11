/**
 * What is for sale, priced per HOUSEHOLD — both people, never per seat.
 *
 * Durations are in DAYS, not months: "one month" is ambiguous on the 31st, and
 * the paywall says "30 ngày" / "365 ngày" for the same reason. `durationDays:
 * null` is lifetime.
 *
 * These are constants in code rather than configuration because changing a
 * price deserves review. Discounts, which are campaigns, are env — see
 * `config/billing.config.ts`.
 */
export const PLAN_CATALOG = {
  premium_monthly: { amountVnd: 39_000, durationDays: 30 },
  premium_yearly: { amountVnd: 299_000, durationDays: 365 },
  premium_lifetime: { amountVnd: 699_000, durationDays: null },
} as const;

export type PlanCode = keyof typeof PLAN_CATALOG;

export const PLAN_CODES = Object.keys(PLAN_CATALOG) as PlanCode[];

/**
 * The struck-through price beside the yearly plan. COMPUTED from the monthly
 * price so the two can never drift — typing 468.000đ by hand would quietly
 * become a lie the first time the monthly price moved.
 */
export const YEARLY_REFERENCE_VND =
  PLAN_CATALOG.premium_monthly.amountVnd * 12;

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === 'string' && value in PLAN_CATALOG;
}
