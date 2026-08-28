/**
 * Date arithmetic for the forecast / projection engines.
 *
 * Every calculation in the v3.1 engines is anchored to an explicit `asOfDate`
 * that the caller passes in — the pure functions never read the clock
 * themselves. `todayInTimeZone()` is called exactly once, at the
 * controller/service boundary, so every calculation is deterministic and
 * unit-testable without freezing time.
 *
 * All dates are ISO `YYYY-MM-DD` strings and all arithmetic runs in UTC, so a
 * date never shifts by a day because of the host's local timezone.
 */

/** ISO calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

/**
 * The household timezone. Oursight is Vietnam-first, so the day boundary
 * that matters for "is this bill due today" is Indochina Time, not UTC and not
 * whatever the server happens to run in.
 */
export const DEFAULT_HOUSEHOLD_TZ = 'Asia/Ho_Chi_Minh';

/** Today (`YYYY-MM-DD`) in the given timezone. The only clock read in the engines. */
export function todayInTimeZone(
  timeZone: string = DEFAULT_HOUSEHOLD_TZ,
): IsoDate {
  // en-CA formats as YYYY-MM-DD; the timeZone option shifts the day boundary.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Parse an ISO date into a UTC-midnight Date. */
function toUtcDate(isoDate: IsoDate): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}

/** Add `days` calendar days to an ISO date. Negative values subtract. */
export function addDaysIso(isoDate: IsoDate, days: number): IsoDate {
  const d = toUtcDate(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Add `months` calendar months to an ISO date, clamped to the target month's
 * length — Jan 31 + 1 month is Feb 28 (or Feb 29), never Mar 3.
 *
 * This clamping is load-bearing: a monthly cashflow event on the 31st must
 * produce one occurrence per month, and the same function drives both the
 * forecast's virtual occurrences and the completion action's date advance, so
 * the two can never disagree.
 */
export function addMonthsIso(isoDate: IsoDate, months: number): IsoDate {
  const d = toUtcDate(isoDate);
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * The last day of the month `isoDate` falls in.
 *
 * Day 0 of the NEXT month is the last day of this one, which handles February
 * and leap years without a table.
 */
export function endOfMonthIso(isoDate: IsoDate): IsoDate {
  const d = toUtcDate(isoDate);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
}

/** Whole calendar days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetweenIso(from: IsoDate, to: IsoDate): number {
  const ms = toUtcDate(to).getTime() - toUtcDate(from).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * Whole calendar months from `from` to `to`, counting only months that have
 * fully elapsed (2026-01-31 → 2026-02-28 is 0 months, not 1).
 *
 * Used by the goal projection to answer "how many months until the target
 * date" — a partial month must not be counted as available runway.
 */
export function monthsBetweenIso(from: IsoDate, to: IsoDate): number {
  const a = toUtcDate(from);
  const b = toUtcDate(to);
  let months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) {
    months -= 1;
  }
  return months;
}

/** `true` when `a` is the same day as or earlier than `b`. */
export function isOnOrBeforeIso(a: IsoDate, b: IsoDate): boolean {
  return a <= b;
}

/** The earlier of two ISO dates. */
export function minIso(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}
