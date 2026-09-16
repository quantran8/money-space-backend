/**
 * What a market-priced holding has done since the last recorded point.
 *
 * Pure: the caller supplies both frozen figures. See [[asset-valuation]] for
 * where the baseline comes from and why null is a real answer.
 */

export interface AssetValueChange {
  /** `YYYY-MM-DD` of the baseline. Often yesterday, but NOT guaranteed. */
  previousDate: string;
  previousValue: number;
  /** Signed: negative when the holding lost value. */
  delta: number;
  /** Signed percent, or null when there is no meaningful base to divide by. */
  deltaPercent: number | null;
}

export interface AssetValueChangeTotal {
  delta: number;
  deltaPercent: number | null;
  /** Holdings that had a baseline and so are counted in `delta`. */
  assetCount: number;
  /** Market-priced holdings with no baseline: the total is PARTIAL. */
  missingCount: number;
  /** Oldest baseline among the contributors — the total is "since then". */
  previousDate: string | null;
}

/**
 * The change since `previousDate`, or `null` when there is no baseline.
 *
 * Both figures are already đồng — `asset_valuations.value` stores a VND total,
 * so nothing here converts currency.
 */
export function buildAssetValueChange(
  previousDate: string | null,
  previousValue: number | null,
  currentValue: number,
): AssetValueChange | null {
  if (previousDate === null || previousValue === null) {
    return null;
  }

  const delta = currentValue - previousValue;

  return {
    previousDate,
    previousValue,
    delta,
    // A holding that was worth nothing has no percentage to report.
    deltaPercent: previousValue > 0 ? (delta / previousValue) * 100 : null,
  };
}

/**
 * The portfolio's move, summed over the holdings that have a baseline.
 *
 * `null` when none does — a household with nothing to compare gets no line at
 * all, not a zero. See [[asset-valuation]].
 */
export function buildAssetValueChangeTotal(
  changes: Array<AssetValueChange | null>,
): AssetValueChangeTotal | null {
  const present = changes.filter(
    (change): change is AssetValueChange => change !== null,
  );
  if (changes.length === 0) {
    return null;
  }

  const delta = present.reduce((sum, change) => sum + change.delta, 0);
  const previousTotal = present.reduce(
    (sum, change) => sum + change.previousValue,
    0,
  );
  const previousDates = present.map((change) => change.previousDate).sort();

  return {
    delta,
    // Divided by what these same holdings were worth, never by the whole
    // portfolio — a market-only numerator over a full denominator means nothing.
    deltaPercent: previousTotal > 0 ? (delta / previousTotal) * 100 : null,
    assetCount: present.length,
    missingCount: changes.length - present.length,
    previousDate: previousDates[0] ?? null,
  };
}
