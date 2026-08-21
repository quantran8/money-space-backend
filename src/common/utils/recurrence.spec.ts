import {
  MAX_OCCURRENCES_PER_EVENT,
  expandOccurrences,
  nextOccurrenceAfter,
  occurrenceAt,
} from './recurrence';

const WINDOW = { asOfDate: '2026-08-13', horizonEndDate: '2026-09-12' }; // 30 days

describe('occurrenceAt', () => {
  it('steps by the right cadence', () => {
    expect(occurrenceAt('2026-08-13', 'weekly', 2)).toBe('2026-08-27');
    expect(occurrenceAt('2026-08-13', 'monthly', 2)).toBe('2026-10-13');
    expect(occurrenceAt('2026-08-13', 'quarterly', 2)).toBe('2027-02-13');
    expect(occurrenceAt('2026-08-13', 'yearly', 2)).toBe('2028-08-13');
  });

  it('never moves a one-off', () => {
    expect(occurrenceAt('2026-08-13', 'once', 5)).toBe('2026-08-13');
  });

  // Measuring from the origin (not iteratively) is what keeps the 31st.
  it('keeps the original day-of-month across a short month', () => {
    expect(occurrenceAt('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    expect(occurrenceAt('2026-01-31', 'monthly', 2)).toBe('2026-03-31');
    expect(occurrenceAt('2026-01-31', 'monthly', 3)).toBe('2026-04-30');
  });
});

describe('nextOccurrenceAfter', () => {
  it('returns null for a one-off — nothing follows it', () => {
    expect(nextOccurrenceAfter('2026-08-13', 'once')).toBeNull();
  });

  it('advances by exactly one period', () => {
    expect(nextOccurrenceAfter('2026-08-13', 'weekly')).toBe('2026-08-20');
    expect(nextOccurrenceAfter('2026-08-13', 'monthly')).toBe('2026-09-13');
    expect(nextOccurrenceAfter('2026-01-31', 'monthly')).toBe('2026-02-28');
  });
});

describe('expandOccurrences', () => {
  it('includes a one-off inside the window', () => {
    const out = expandOccurrences({
      ...WINDOW,
      expectedDate: '2026-08-20',
      recurrence: 'once',
    });
    expect(out).toEqual([
      {
        index: 0,
        date: '2026-08-20',
        isVirtual: false,
        wasClampedFromPast: false,
      },
    ]);
  });

  it('excludes a one-off beyond the horizon', () => {
    expect(
      expandOccurrences({
        ...WINDOW,
        expectedDate: '2026-10-01',
        recurrence: 'once',
      }),
    ).toEqual([]);
  });

  it('includes an event exactly on the horizon end, excludes the next day', () => {
    expect(
      expandOccurrences({
        ...WINDOW,
        expectedDate: '2026-09-12',
        recurrence: 'once',
      }),
    ).toHaveLength(1);
    expect(
      expandOccurrences({
        ...WINDOW,
        expectedDate: '2026-09-13',
        recurrence: 'once',
      }),
    ).toHaveLength(0);
  });

  it('expands a monthly series across the window', () => {
    const out = expandOccurrences({
      asOfDate: '2026-08-13',
      horizonEndDate: '2026-11-13',
      expectedDate: '2026-08-15',
      recurrence: 'monthly',
    });
    // 2026-11-15 falls past the 2026-11-13 horizon end, so it is excluded.
    expect(out.map((o) => o.date)).toEqual([
      '2026-08-15',
      '2026-09-15',
      '2026-10-15',
    ]);
    expect(out[0].isVirtual).toBe(false);
    expect(out[1].isVirtual).toBe(true);
  });

  it('clamps a monthly series to month length', () => {
    const out = expandOccurrences({
      asOfDate: '2026-01-01',
      horizonEndDate: '2026-05-01',
      expectedDate: '2026-01-31',
      recurrence: 'monthly',
    });
    expect(out.map((o) => o.date)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  it('stops at recurrenceEndDate', () => {
    const out = expandOccurrences({
      asOfDate: '2026-08-13',
      horizonEndDate: '2026-12-31',
      expectedDate: '2026-08-15',
      recurrence: 'monthly',
      recurrenceEndDate: '2026-10-20',
    });
    expect(out.map((o) => o.date)).toEqual([
      '2026-08-15',
      '2026-09-15',
      '2026-10-15',
    ]);
  });

  // An unpaid bill still has to be paid out of today's cash.
  it('clamps an overdue one-off onto asOfDate', () => {
    const out = expandOccurrences({
      ...WINDOW,
      expectedDate: '2026-08-08',
      recurrence: 'once',
    });
    expect(out).toEqual([
      {
        index: 0,
        date: '2026-08-13',
        isVirtual: false,
        wasClampedFromPast: true,
        // The clamp keeps the real due date so the timeline can show it.
        originalDate: '2026-08-08',
      },
    ]);
  });

  // The regression that would make a neglected household look catastrophic:
  // a year-stale monthly series must not emit twelve phantom charges.
  it('collapses a year of missed monthly occurrences into ONE clamped charge', () => {
    const out = expandOccurrences({
      asOfDate: '2026-08-13',
      horizonEndDate: '2026-09-12',
      expectedDate: '2025-08-15',
      recurrence: 'monthly',
    });
    const clamped = out.filter((o) => o.wasClampedFromPast);
    expect(clamped).toHaveLength(1);
    expect(clamped[0].date).toBe('2026-08-13');
    // Plus the genuine upcoming occurrence still inside the window.
    expect(out.map((o) => o.date)).toEqual(['2026-08-13', '2026-08-15']);
  });

  it('terminates and stays bounded for a corrupt far-past weekly row', () => {
    const out = expandOccurrences({
      asOfDate: '2026-08-13',
      horizonEndDate: '2026-09-12',
      expectedDate: '1970-01-01',
      recurrence: 'weekly',
    });
    expect(out.length).toBeLessThanOrEqual(MAX_OCCURRENCES_PER_EVENT);
    expect(out.filter((o) => o.wasClampedFromPast)).toHaveLength(1);
  });

  it('returns nothing when the series ends before the window', () => {
    const out = expandOccurrences({
      ...WINDOW,
      expectedDate: '2026-06-01',
      recurrence: 'monthly',
      recurrenceEndDate: '2026-07-01',
    });
    // The series is over, but it was never completed — one clamped charge.
    expect(out).toEqual([
      {
        index: 0,
        date: '2026-08-13',
        isVirtual: false,
        wasClampedFromPast: true,
        // The series' last scheduled date is what is still owed.
        originalDate: '2026-07-01',
      },
    ]);
  });

  // Forecast and completion must agree: the step after the stored date is the
  // same date the forecast predicts as the next occurrence.
  it('agrees with nextOccurrenceAfter', () => {
    const out = expandOccurrences({
      asOfDate: '2026-08-13',
      horizonEndDate: '2026-12-31',
      expectedDate: '2026-08-15',
      recurrence: 'monthly',
    });
    expect(out[1].date).toBe(nextOccurrenceAfter('2026-08-15', 'monthly'));
  });
});
