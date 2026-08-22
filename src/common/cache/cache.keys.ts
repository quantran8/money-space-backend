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

  /**
   * Provider quotes. Deliberately NOT under the `hh:` prefix: market data is
   * global, identical for every household, and must survive the per-household
   * invalidation that fires after each write — a household editing an asset has
   * not changed what BTC is worth.
   */
  marketPrices: () => 'market:prices',

  /** Provider reference lists (the symbol picker), keyed by asset class. */
  symbolReference: (assetClass: string) => `market:symbols:${assetClass}`,

  /** Vietnamese dealer gold quotes. Global, like every other market figure. */
  goldPrices: () => 'market:gold',

  /** Bank counter rates against VND. */
  fxCounterRates: () => 'market:fx-counter',

  /** Persisted reference FX rates from `fx_rates`. */
  fxRates: () => 'market:fx-rates',

  /**
   * An on-demand quote for a single instrument the household may not hold yet
   * (the asset-create flow). Keyed by everything that changes the answer.
   */
  quote: (
    assetClass: string,
    symbol: string,
    market: string,
    quoteCurrency: string,
  ) => `market:quote:${assetClass}:${symbol}:${market}:${quoteCurrency}`,
} as const;

/** Entry lifetimes, in seconds. */
export const cacheTtl = {
  /**
   * Household views are invalidated explicitly on every write, so this TTL is
   * only a backstop against a missed invalidation — not the primary freshness
   * mechanism. Hence minutes rather than seconds.
   */
  household: 300,

  /**
   * Quotes. Short: this is live market data, and the figure drives what the
   * user is told their money is worth. Overridable via
   * `MARKET_PRICE_CACHE_TTL_MS` (expressed there in ms, for the in-process
   * layer that shares the same budget).
   */
  marketPrices: 300,

  /**
   * Reference lists (which instruments exist). Long: these are large,
   * near-static listings, and re-fetching them costs provider call credits
   * without changing the answer.
   */
  symbolReference: 24 * 60 * 60,

  /**
   * Gold and bank counter rates. Dealers republish a few times a day (the BTMC
   * feed carries ~2 publish times), and banks move rates intraday, so a short
   * TTL keeps the figure current without hammering a free upstream.
   */
  commodity: 300,

  /**
   * Persisted reference FX rates. Longer than the live figures: these are
   * written by the daily refresh, not intraday, so re-querying Postgres per
   * request buys nothing.
   */
  fxRates: 900,
} as const;
