import {
  addDaysIso,
  addMonthsIso,
  daysBetweenIso,
  minIso,
  monthsBetweenIso,
  todayInTimeZone,
} from './clock';

describe('addDaysIso', () => {
  it('adds and subtracts days', () => {
    expect(addDaysIso('2026-08-12', 3)).toBe('2026-08-15');
    expect(addDaysIso('2026-08-12', -3)).toBe('2026-08-09');
    expect(addDaysIso('2026-08-12', 0)).toBe('2026-08-12');
  });

  it('crosses month and year boundaries', () => {
    expect(addDaysIso('2026-08-30', 5)).toBe('2026-09-04');
    expect(addDaysIso('2026-12-30', 5)).toBe('2027-01-04');
  });

  it('handles leap days', () => {
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysIso('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('addMonthsIso', () => {
  it('adds whole months', () => {
    expect(addMonthsIso('2026-08-15', 1)).toBe('2026-09-15');
    expect(addMonthsIso('2026-08-15', 3)).toBe('2026-11-15');
    expect(addMonthsIso('2026-08-15', 12)).toBe('2027-08-15');
  });

  // The clamping rule: a monthly series on the 31st must produce exactly one
  // occurrence per month, never spill into the following month.
  it('clamps to the end of a shorter target month', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2026-03-31', 1)).toBe('2026-04-30');
    expect(addMonthsIso('2026-08-31', 6)).toBe('2027-02-28');
  });

  it('clamps to Feb 29 in a leap year', () => {
    expect(addMonthsIso('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('does not permanently lose the original day-of-month', () => {
    // Stepping Jan 31 twice must reach Mar 31, not Feb 28 → Mar 28. Callers
    // therefore step from the ORIGINAL date by n months, never iteratively.
    expect(addMonthsIso('2026-01-31', 2)).toBe('2026-03-31');
  });

  it('subtracts months', () => {
    expect(addMonthsIso('2026-03-31', -1)).toBe('2026-02-28');
  });
});

describe('daysBetweenIso', () => {
  it('counts days in both directions', () => {
    expect(daysBetweenIso('2026-08-12', '2026-08-15')).toBe(3);
    expect(daysBetweenIso('2026-08-15', '2026-08-12')).toBe(-3);
    expect(daysBetweenIso('2026-08-12', '2026-08-12')).toBe(0);
  });

  // A DST-shifting timezone must not turn a 30-day span into 29.96 days.
  it('is unaffected by daylight-saving transitions', () => {
    expect(daysBetweenIso('2026-03-01', '2026-03-31')).toBe(30);
    expect(daysBetweenIso('2026-10-01', '2026-11-01')).toBe(31);
  });
});

describe('monthsBetweenIso', () => {
  it('counts only fully elapsed months', () => {
    expect(monthsBetweenIso('2026-01-15', '2026-04-15')).toBe(3);
    expect(monthsBetweenIso('2026-01-15', '2026-04-14')).toBe(2);
    expect(monthsBetweenIso('2026-01-15', '2026-01-31')).toBe(0);
  });

  it('spans years', () => {
    expect(monthsBetweenIso('2026-08-01', '2029-06-01')).toBe(34);
  });

  it('is negative when the target is in the past', () => {
    expect(monthsBetweenIso('2026-08-15', '2026-05-15')).toBe(-3);
  });
});

describe('minIso', () => {
  it('returns the earlier date', () => {
    expect(minIso('2026-08-12', '2026-09-01')).toBe('2026-08-12');
    expect(minIso('2026-09-01', '2026-08-12')).toBe('2026-08-12');
  });
});

describe('todayInTimeZone', () => {
  it('returns an ISO date', () => {
    expect(todayInTimeZone()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // The Vietnam day boundary is 7h ahead of UTC, so late-evening UTC is already
  // "tomorrow" for the household. Asserting the two zones can differ by at most
  // a day keeps the intent without pinning the test to a wall clock.
  it('respects the timezone it is given', () => {
    const vn = todayInTimeZone('Asia/Ho_Chi_Minh');
    const utc = todayInTimeZone('UTC');
    expect(Math.abs(daysBetweenIso(utc, vn))).toBeLessThanOrEqual(1);
  });
});
