import type { AssetClass } from './asset.entity';

export interface MarketPosition {
  assetClass: AssetClass;
  symbol: string;
  /**
   * Venue the instrument trades on, e.g. `HOSE`, `HNX`, `UPCOM`, `NASDAQ`.
   * Set from the symbol picker's reference data. Price routing reads it to tell
   * a Vietnamese listing from a foreign one — both are `assetClass: 'stock'` —
   * so leaving it unset falls back to a currency heuristic.
   */
  market?: string;
  quantity: number;
  unit: string;
  quoteCurrency: string;
  /**
   * Original purchase price of one unit. This is the cost basis and must not be
   * overwritten by a later manual revaluation.
   */
  purchasePrice?: number;
  /** Latest manually entered or externally fetched market price. */
  lastPrice?: number;
  /** ISO timestamp at which `lastPrice` was observed. */
  lastPriceAt?: string;
  /**
   * Today's price from the shared market cache, in `marketPriceCurrency`.
   *
   * Deliberately SEPARATE from `lastPrice`, which is a stored fact — what was
   * recorded, and when. Overwriting it here would make `lastPriceAt` mean "when
   * we fetched" rather than "when it was observed", and the freshness signal
   * reads exactly that field.
   *
   * Read-only and never persisted: `listAssets` fills it per response from the
   * batched 5-minute cache, so it costs no extra provider call. Absent when the
   * instrument is not in the cache (unpriceable, or the feed is down).
   */
  marketPrice?: number;
  /** Currency of `marketPrice` — the instrument's OWN, never converted. */
  marketPriceCurrency?: string;
  /** ISO timestamp the upstream observed `marketPrice`. */
  marketPriceAt?: string;
}
