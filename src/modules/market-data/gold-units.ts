/**
 * The units gold is held in here, and how many of each make up one lượng.
 *
 * Dealers publish a single figure per lượng, so a holding kept in chỉ or gram
 * has no quote of its own — it is derived from the per-lượng figure. This table
 * is the one source of truth for that ratio: the frontend used to divide by its
 * own copy while the backend valued positions at the raw per-lượng price, so a
 * holding in chỉ was shown at the form's figure and valued at ten times it.
 */
const GOLD_UNITS_PER_LUONG: Readonly<Record<string, number>> = {
  chỉ: 10,
  lượng: 1,
  gram: 37.5,
};

/** The unit dealers quote in, and the default when a holding names none. */
export const GOLD_QUOTE_UNIT = 'lượng';

/** Every unit a gold quote is published in. Order is the form's picker order. */
export const GOLD_UNITS = Object.keys(GOLD_UNITS_PER_LUONG);

/**
 * One per-lượng figure spread across every unit gold is held in.
 *
 * The feed quotes a single number, so switching chỉ → gram in the form is a
 * lookup, not another request — the whole set rides along with the quote.
 */
export function goldPricesByUnit(
  pricePerLuong: number,
): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const unit of GOLD_UNITS) {
    prices[unit] = convertGoldPricePerUnit(pricePerLuong, unit);
  }
  return prices;
}

/** Whether a per-lượng quote can be restated into `unit`. */
export function isConvertibleGoldUnit(unit: string): boolean {
  return unit.trim().toLowerCase() in GOLD_UNITS_PER_LUONG;
}

/**
 * A per-lượng gold quote restated into `unit`.
 *
 * Returns the price unchanged for a unit outside the table, which is what a
 * record saved before the unit picker existed can still carry: a guessed
 * divisor would be worse than the dealer's own figure.
 */
export function convertGoldPricePerUnit(
  pricePerLuong: number,
  unit: string,
): number {
  const perLuong = GOLD_UNITS_PER_LUONG[unit.trim().toLowerCase()];
  return perLuong ? pricePerLuong / perLuong : pricePerLuong;
}

/** The canonical spelling of `unit`, or `lượng` when it is not one we know. */
export function normalizeGoldUnit(unit: string | undefined): string {
  const trimmed = unit?.trim().toLowerCase() ?? '';
  return trimmed in GOLD_UNITS_PER_LUONG ? trimmed : GOLD_QUOTE_UNIT;
}
