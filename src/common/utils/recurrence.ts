/**
 * Recurrence expansion for cashflow events (spec §18, §2.15).
 *
 * A recurring cashflow event is ONE row: `expectedDate` is the current
 * occurrence and `recurrence` is the rule for the rest. Future occurrences are
 * generated **virtually** for the forecast and never written as rows — the spec
 * is explicit that occurrence rows must not be pre-created.
 *
 * This module is the single implementation of "when is the next one?", used by
 * BOTH the forecast (expanding a horizon) and the completion action (advancing
 * `expected_date`). If those two ever used different logic, completing an event
 * would move it somewhere the forecast did not predict.
 *
 * Pure: every function takes the dates it needs. Nothing reads the clock.
 */

import { addDaysIso, addMonthsIso, type IsoDate } from './clock';

export type RecurrenceFrequency =
  'once' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/**
 * Runaway guard. A corrupt row (`weekly`, `expectedDate` in 1970) must not spin
 * generating occurrences forever. 400 comfortably covers the longest supported
 * horizon at weekly cadence (~7.7 years).
 */
export const MAX_OCCURRENCES_PER_EVENT = 400;

/**
 * The date of the `step`-th occurrence after `start`.
 *
 * Always measured from the ORIGINAL date, never by iterating one step at a
 * time: stepping Jan 31 forward twice iteratively gives Feb 28 → Mar 28, losing
 * the 31st permanently. Measuring from the origin gives Mar 31, which is what a
 * "monthly on the 31st" event means.
 */
export function occurrenceAt(
  start: IsoDate,
  recurrence: RecurrenceFrequency,
  step: number,
): IsoDate {
  if (step === 0 || recurrence === 'once') {
    return start;
  }
  switch (recurrence) {
    case 'weekly':
      return addDaysIso(start, 7 * step);
    case 'monthly':
      return addMonthsIso(start, step);
    case 'quarterly':
      return addMonthsIso(start, 3 * step);
    case 'yearly':
      return addMonthsIso(start, 12 * step);
  }
}

/**
 * The next occurrence strictly after `current`, for the completion action.
 * Returns `null` for a one-off (nothing follows it).
 */
export function nextOccurrenceAfter(
  current: IsoDate,
  recurrence: RecurrenceFrequency,
): IsoDate | null {
  if (recurrence === 'once') {
    return null;
  }
  return occurrenceAt(current, recurrence, 1);
}

export interface ExpandedOccurrence {
  /** 0 = the stored `expectedDate`; higher values are virtual. */
  index: number;
  date: IsoDate;
  /** `true` for everything the forecast generated rather than read. */
  isVirtual: boolean;
  /**
   * `true` when the stored date is already in the past and the occurrence was
   * pulled onto `asOfDate`.
   */
  wasClampedFromPast: boolean;
}

export interface ExpandOptions {
  expectedDate: IsoDate;
  recurrence: RecurrenceFrequency;
  recurrenceEndDate?: IsoDate | null;
  /** Start of the forecast window. Past occurrences are clamped onto this. */
  asOfDate: IsoDate;
  /** Inclusive end of the forecast window. */
  horizonEndDate: IsoDate;
}

/**
 * Every occurrence of an event falling inside `[asOfDate, horizonEndDate]`.
 *
 * **Overdue handling.** An unpaid bill from last week still has to come out of
 * today's cash, so an occurrence before `asOfDate` is pulled onto `asOfDate`
 * and flagged `wasClampedFromPast`. Crucially, only ONE is: a monthly series
 * nobody has completed for a year would otherwise emit twelve phantom charges
 * and make the forecast look catastrophic. All past steps collapse into that
 * single clamped occurrence.
 */
export function expandOccurrences(
  options: ExpandOptions,
): ExpandedOccurrence[] {
  const {
    expectedDate,
    recurrence,
    recurrenceEndDate,
    asOfDate,
    horizonEndDate,
  } = options;

  // The series never reaches the window.
  if (recurrenceEndDate && recurrenceEndDate < asOfDate) {
    // A one-off/series whose last date is already past still owes money if it
    // was never completed — handled by the clamp below, not dropped here.
    if (recurrence !== 'once' && expectedDate < asOfDate) {
      return [
        {
          index: 0,
          date: asOfDate,
          isVirtual: false,
          wasClampedFromPast: true,
        },
      ];
    }
  }

  const occurrences: ExpandedOccurrence[] = [];
  let sawPast = false;

  for (let step = 0; step < MAX_OCCURRENCES_PER_EVENT; step += 1) {
    const date = occurrenceAt(expectedDate, recurrence, step);

    if (recurrenceEndDate && date > recurrenceEndDate) {
      break;
    }

    if (date < asOfDate) {
      // Collapse every past step into one clamped occurrence at asOfDate.
      if (!sawPast) {
        sawPast = true;
        occurrences.push({
          index: step,
          date: asOfDate,
          isVirtual: false,
          wasClampedFromPast: true,
        });
      }
      if (recurrence === 'once') {
        break;
      }
      continue;
    }

    if (date > horizonEndDate) {
      break;
    }

    occurrences.push({
      index: step,
      date,
      isVirtual: step > 0,
      wasClampedFromPast: false,
    });

    if (recurrence === 'once') {
      break;
    }
  }

  return occurrences;
}
