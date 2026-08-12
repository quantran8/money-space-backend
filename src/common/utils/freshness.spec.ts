import { freshnessOf, staleAfterDaysFor } from './freshness';

const TODAY = '2026-08-13';

describe('staleAfterDaysFor', () => {
  it('gives each cadence a day of grace', () => {
    // A household that updates every Sunday must not flip to stale for a few
    // hours every Sunday morning.
    expect(staleAfterDaysFor('weekly')).toBe(8);
    // 31 covers the longest month, for the same reason.
    expect(staleAfterDaysFor('monthly')).toBe(31);
  });

  /**
   * A household on `manual` explicitly said "we'll update when we want to".
   * Grading them against a schedule they never agreed to is exactly the nagging
   * §29 forbids — so `manual` has no staleness window at all.
   */
  it('never expires a manual cadence', () => {
    expect(staleAfterDaysFor('manual')).toBeNull();
  });
});

describe('freshnessOf', () => {
  it('is fresh well inside the window', () => {
    expect(freshnessOf(TODAY, '2026-08-12', 'weekly')).toEqual({
      state: 'fresh',
      daysSinceUpdate: 1,
      staleAfterDays: 8,
    });
  });

  it('ages in the last quarter of the window before going stale', () => {
    // 8-day window → aging from day 6.
    expect(freshnessOf(TODAY, '2026-08-07', 'weekly').state).toBe('aging');
    expect(freshnessOf(TODAY, '2026-08-05', 'weekly').state).toBe('stale');
  });

  it('is stale exactly ON the boundary', () => {
    expect(freshnessOf(TODAY, '2026-08-05', 'weekly').daysSinceUpdate).toBe(8);
    expect(freshnessOf(TODAY, '2026-08-05', 'weekly').state).toBe('stale');
  });

  /**
   * "We don't know when this was valued" and "this value is old" are different
   * claims. Reporting an undated value as stale asserts something we cannot
   * support — and would make every freshly-imported asset look neglected.
   */
  it('reports an undated value as unknown, never stale', () => {
    expect(freshnessOf(TODAY, null, 'weekly')).toEqual({
      state: 'unknown',
      daysSinceUpdate: null,
      staleAfterDays: 8,
    });
    expect(freshnessOf(TODAY, undefined, 'monthly').state).toBe('unknown');
  });

  it('never goes stale on a manual cadence, however old', () => {
    const result = freshnessOf(TODAY, '2019-01-01', 'manual');
    expect(result.state).toBe('fresh');
    // The age is still reported — the household can see it, they just aren't
    // graded on it.
    expect(result.daysSinceUpdate).toBeGreaterThan(2000);
  });

  it('accepts a full ISO timestamp, not just a date', () => {
    expect(
      freshnessOf(TODAY, '2026-08-12T23:45:00.000Z', 'weekly').daysSinceUpdate,
    ).toBe(1);
  });

  /** A value dated in the future is a clock skew, not negative age. */
  it('floors age at zero', () => {
    expect(freshnessOf(TODAY, '2026-09-01', 'weekly').daysSinceUpdate).toBe(0);
  });
});
