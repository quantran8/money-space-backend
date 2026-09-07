import type {
  PlanLimits,
  PremiumFeature,
  SubscriptionTier,
} from '../entities/entitlement.entity';

/**
 * What each tier allows. **The single source of truth** — the frontend receives
 * this object inside `GET /entitlement` and hardcodes nothing, so moving Free
 * from 2 goals to 3 is one line here and needs no app-store release.
 *
 * Where the Free ceilings sit, and why:
 *
 * - **2 goals.** Two is the smallest number that still shows what goals are
 *   for: priority (low/high) and "which goal gives way" in a what-if are both
 *   meaningless with one. A real couple usually has three or more, so the
 *   ceiling is met naturally rather than as an artificial wall.
 * - **5 what-ifs a month.** Enough to reach the Consequence Moment several
 *   times over. Anyone actually using the app before decisions passes it in
 *   the first month, which is exactly the household worth charging.
 * - **2 auto-priced assets.** The one limit with a real marginal cost behind it
 *   (CoinMarketCap, Twelve Data). Note what is NOT limited: recording gold,
 *   stocks or crypto at all. Blocking that would block the balance sheet a
 *   Vietnamese household opens the app for — they would leave rather than pay.
 *   What Premium sells is the automation.
 * - **7/30-day horizon.** 30 days answers "will we make it to payday", which is
 *   the question that drives adoption. 60/90 is planning, which is what
 *   foresight is worth paying for.
 *
 * Every figure is a hypothesis until there are real households to measure. They
 * live here, in one file, precisely so they are cheap to revise.
 */
export const PLAN_LIMITS: Record<SubscriptionTier, PlanLimits> = {
  free: {
    goals: 2,
    whatIfPerMonth: 5,
    marketPricedAssets: 2,
    forecastHorizons: [7, 30],
    historyMonths: 3,
    exportData: false,
  },
  premium: {
    goals: null,
    whatIfPerMonth: null,
    marketPricedAssets: null,
    forecastHorizons: [7, 30, 60, 90],
    historyMonths: null,
    exportData: true,
  },
} as const;

/** Whether a tier's limits grant one boolean feature. */
export function hasFeature(
  limits: PlanLimits,
  feature: PremiumFeature,
): boolean {
  switch (feature) {
    case 'forecast_horizon_extended':
      // Anything beyond the 30-day view every household gets.
      return limits.forecastHorizons.some((days) => days > 30);
    case 'history_full':
      return limits.historyMonths === null;
    case 'export_data':
      return limits.exportData;
  }
}
