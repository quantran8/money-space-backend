export interface FxRate {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  asOf: string;
  source: string;
}

/**
 * A bank's published counter rates for one currency against VND.
 *
 * Unlike `FxRate` (a single mid/reference rate, persisted in `fx_rates`) this is
 * the live three-way spread a Vietnamese bank quotes, which is what a household
 * actually transacts at. All three are **VND per one unit** of `currencyCode` —
 * verified against cross-rates (implied USD/JPY 155.2, USD/KRW 1339), so the
 * per-100 convention some banks publish for JPY/KRW does NOT apply here.
 */
export interface FxCounterRate {
  /** ISO-4217 code, e.g. `USD`, `JPY`. */
  currencyCode: string;
  /** Currency name as the bank publishes it, e.g. "US DOLLAR". */
  currencyName: string;
  /**
   * What the bank pays for banknotes, or `null` when it does not buy cash in
   * that currency — upstream reports this as `0`, which is not a real rate.
   */
  buyCash: number | null;
  /** What the bank pays for a wire transfer, or `null` when not quoted. */
  buyTransfer: number | null;
  /** What the bank charges to sell you the currency, or `null` when not quoted. */
  sell: number | null;
  /** Upstream that supplied the quote. */
  source: string;
}
