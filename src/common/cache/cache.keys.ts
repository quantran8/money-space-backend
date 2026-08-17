/**
 * Every cache key in the app is built here.
 *
 * The point is that reads and invalidation can never drift apart: a cached view
 * MUST live under `household(householdId)` so that one `delByPrefix` after a
 * write drops all of them. A key built ad-hoc in a service would silently
 * survive invalidation and serve stale money figures.
 */
export const cacheKeys = {
  /**
   * Prefix owning every per-household cached view. Invalidating a household is
   * `delByPrefix(cacheKeys.household(id))`.
   */
  household: (householdId: string) => `hh:${householdId}:`,

  dashboard: (householdId: string) => `hh:${householdId}:dashboard`,

  forecast: (householdId: string, horizonMonths: number) =>
    `hh:${householdId}:forecast:${horizonMonths}`,
} as const;

/** Entry lifetimes, in seconds. */
export const cacheTtl = {
  /**
   * Household views are invalidated explicitly on every write, so this TTL is
   * only a backstop against a missed invalidation — not the primary freshness
   * mechanism. Hence minutes rather than seconds.
   */
  household: 300,
} as const;
