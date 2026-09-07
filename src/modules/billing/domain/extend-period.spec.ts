import { MAX_PERIOD_DAYS, extendPeriod, type Grant } from './extend-period';

const NOW = new Date('2026-09-07T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function run(
  grant: Grant,
  currentPeriodEnd: Date | null = null,
  isLifetime = false,
) {
  return extendPeriod({ currentPeriodEnd, isLifetime, now: NOW, grant });
}

describe('extendPeriod — duration_days', () => {
  it('starts from today for a household on free', () => {
    const result = run({ type: 'duration_days', days: 30 });

    expect(result.periodEnd).toEqual(new Date(NOW.getTime() + 30 * DAY));
    expect(result.addedDays).toBe(30);
    expect(result.stacked).toBe(false);
  });

  /** The rule that keeps a code from ever costing someone time they paid for. */
  it('stacks on top of a period that is still running', () => {
    const current = new Date('2026-12-30T00:00:00.000Z');

    const result = run({ type: 'duration_days', days: 90 }, current);

    expect(result.periodEnd).toEqual(new Date(current.getTime() + 90 * DAY));
    expect(result.addedDays).toBe(90);
    expect(result.stacked).toBe(true);
  });

  it('starts from today when the old period has already lapsed, crediting nothing for the gap', () => {
    const result = run(
      { type: 'duration_days', days: 30 },
      new Date('2026-07-01T00:00:00.000Z'),
    );

    expect(result.periodEnd).toEqual(new Date(NOW.getTime() + 30 * DAY));
    expect(result.addedDays).toBe(30);
    expect(result.stacked).toBe(false);
  });

  it('caps at five years so a typo cannot grant a century', () => {
    const result = run({ type: 'duration_days', days: 100_000 });

    expect(result.periodEnd).toEqual(new Date(NOW.getTime() + MAX_PERIOD_DAYS * DAY));
  });

  it('treats a zero-day grant as a no-op', () => {
    expect(run({ type: 'duration_days', days: 0 }).noop).toBe(true);
  });
});

describe('extendPeriod — until_date', () => {
  it('sets the expiry when it is further out than today', () => {
    const until = new Date('2027-01-31T00:00:00.000Z');

    const result = run({ type: 'until_date', until });

    expect(result.periodEnd).toEqual(until);
    expect(result.noop).toBe(false);
  });

  /**
   * Without this, a beta code good "until December" would CUT SHORT a household
   * that had already paid into next year — turning a gift into a penalty.
   */
  it('never shortens a period that already runs past the target date', () => {
    const current = new Date('2027-06-01T00:00:00.000Z');

    const result = run(
      { type: 'until_date', until: new Date('2026-12-31T00:00:00.000Z') },
      current,
    );

    expect(result.periodEnd).toEqual(current);
    expect(result.addedDays).toBe(0);
    // The caller uses this to warn and NOT consume the code.
    expect(result.noop).toBe(true);
  });

  it('is a no-op for a date already in the past', () => {
    const result = run({
      type: 'until_date',
      until: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(result.noop).toBe(true);
    expect(result.addedDays).toBe(0);
  });

  it('caps a far-future target at five years', () => {
    const result = run({
      type: 'until_date',
      until: new Date('2099-01-01T00:00:00.000Z'),
    });

    expect(result.periodEnd).toEqual(new Date(NOW.getTime() + MAX_PERIOD_DAYS * DAY));
  });
});

describe('extendPeriod — lifetime', () => {
  it('clears the expiry entirely', () => {
    const result = run({ type: 'lifetime' });

    expect(result.periodEnd).toBeNull();
    expect(result.noop).toBe(false);
  });

  it('upgrades a running period rather than comparing dates', () => {
    const result = run({ type: 'lifetime' }, new Date('2027-01-01T00:00:00.000Z'));

    expect(result.periodEnd).toBeNull();
    expect(result.noop).toBe(false);
  });

  /** Lifetime absorbs everything after it — no downgrade to a fixed date. */
  it('makes every later grant a no-op once the household owns it', () => {
    for (const grant of [
      { type: 'duration_days', days: 365 },
      { type: 'until_date', until: new Date('2030-01-01T00:00:00.000Z') },
      { type: 'lifetime' },
    ] as Grant[]) {
      const result = run(grant, null, true);

      expect(result.periodEnd).toBeNull();
      expect(result.noop).toBe(true);
    }
  });
});
