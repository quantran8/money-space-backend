import { PLAN_CATALOG, type PlanCode } from './plan-catalog';

/**
 * Store product ids → the plan each one grants. What an IAP COSTS is the
 * store's own price, not `PLAN_CATALOG`'s.
 *
 * **Permanent.** A published product id cannot be renamed or reused, so a new
 * plan means a new id. See `memory/billing-and-entitlement.md`.
 */
export const STORE_PRODUCTS = {
  'oursight_premium_monthly': 'premium_monthly',
  'oursight_premium_yearly': 'premium_yearly',
  'oursight_premium_lifetime': 'premium_lifetime',
} as const satisfies Record<string, PlanCode>;

export type StoreProductId = keyof typeof STORE_PRODUCTS;

/**
 * Which plan a product grants. `null`, not a throw — an unknown product is our
 * misconfiguration, and the webhook still has to answer 200. Play appends
 * `:base-plan-id` in some configurations, so the suffix is stripped.
 */
export function planCodeForProduct(productId: string | null | undefined): PlanCode | null {
  if (!productId) return null;
  const base = productId.split(':')[0];
  return (STORE_PRODUCTS as Record<string, PlanCode>)[base] ?? null;
}

/** Days a product grants; `null` = lifetime. Read from `PLAN_CATALOG`. */
export function durationDaysForProduct(productId: string): number | null | undefined {
  const planCode = planCodeForProduct(productId);
  if (!planCode) return undefined;
  return PLAN_CATALOG[planCode].durationDays;
}
