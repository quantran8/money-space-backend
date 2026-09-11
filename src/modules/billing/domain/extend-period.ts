/** Five years. A guard against admin typos and against stacking forever. */
export const MAX_PERIOD_DAYS = 1825;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type Grant =
  | { type: 'duration_days'; days: number }
  | { type: 'until_date'; until: Date }
  | { type: 'lifetime' };

export interface ExtendInput {
  /** The current expiry. `null` means free, or already lifetime — see below. */
  currentPeriodEnd: Date | null;
  /** True when the household is on a lifetime plan already. */
  isLifetime: boolean;
  now: Date;
  grant: Grant;
}

export interface ExtendResult {
  /** The new expiry. `null` = lifetime. */
  periodEnd: Date | null;
  /** Days actually added. 0 when the grant changed nothing. */
  addedDays: number;
  /** True when this extended a period that was still running. */
  stacked: boolean;
  /** True when the grant made no difference and should not be consumed. */
  noop: boolean;
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MS_PER_DAY);
}

function diffDays(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / MS_PER_DAY));
}

/**
 * Work out the new expiry when a grant is applied.
 *
 * Three rules, each there because breaking it turns a gift into a penalty:
 *
 * 1. **Never lose a day.** The base is `max(currentPeriodEnd, now)`, so a code
 *    redeemed with two months still on the clock adds to those two months
 *    rather than replacing them. A lapsed plan starts from today instead —
 *    nobody is credited for the past.
 * 2. **Never shorten.** An `until_date` code that lands earlier than the
 *    current expiry leaves it alone and reports `noop`, so the caller can warn
 *    the household and decline to spend the code.
 * 3. **Lifetime absorbs everything.** Once a household owns it, later grants
 *    are no-ops rather than a downgrade to a fixed date.
 *
 * Pure, so the transaction around it decides how many times it runs.
 */
export function extendPeriod(input: ExtendInput): ExtendResult {
  const { currentPeriodEnd, isLifetime, now, grant } = input;

  // Rule 3.
  if (isLifetime) {
    return { periodEnd: null, addedDays: 0, stacked: true, noop: true };
  }

  if (grant.type === 'lifetime') {
    return { periodEnd: null, addedDays: 0, stacked: false, noop: false };
  }

  // Rule 1.
  const stillRunning =
    currentPeriodEnd !== null && currentPeriodEnd.getTime() > now.getTime();
  const base = stillRunning ? currentPeriodEnd! : now;

  const ceiling = addDays(now, MAX_PERIOD_DAYS);

  if (grant.type === 'duration_days') {
    const uncapped = addDays(base, grant.days);
    const periodEnd = uncapped.getTime() > ceiling.getTime() ? ceiling : uncapped;

    return {
      periodEnd,
      addedDays: diffDays(base, periodEnd),
      stacked: stillRunning,
      // Only a non-positive grant, or a household already at the ceiling,
      // changes nothing.
      noop: periodEnd.getTime() <= base.getTime(),
    };
  }

  // Rule 2: `until_date` sets a floor, never a cap.
  const target = grant.until.getTime() > ceiling.getTime() ? ceiling : grant.until;
  if (target.getTime() <= base.getTime()) {
    return {
      periodEnd: currentPeriodEnd ?? base,
      addedDays: 0,
      stacked: stillRunning,
      noop: true,
    };
  }

  return {
    periodEnd: target,
    addedDays: diffDays(base, target),
    stacked: stillRunning,
    noop: false,
  };
}
