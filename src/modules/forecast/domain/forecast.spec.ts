import { runForecast } from './forecast';
import type {
  ForecastCashflowEvent,
  ForecastInput,
  ForecastLiquidSource,
} from './forecast.types';

const M = 1_000_000;

function asset(over: Partial<ForecastLiquidSource> = {}): ForecastLiquidSource {
  return {
    assetId: 'asset-1',
    name: 'VCB',
    value: 20 * M,
    liquidity: 'usable_now',
    financialNature: 'household',
    visibilityLevel: 'detail',
    valueUpdatedAt: '2026-08-13',
    ...over,
  };
}

function event(
  over: Partial<ForecastCashflowEvent> = {},
): ForecastCashflowEvent {
  return {
    id: 'cf-1',
    name: 'Event',
    direction: 'outgoing',
    amount: 1 * M,
    expectedDate: '2026-08-15',
    recurrence: 'once',
    recurrenceEndDate: null,
    requirement: 'required',
    certainty: 'confirmed',
    status: 'expected',
    visibilityLevel: 'detail',
    ...over,
  };
}

function input(over: Partial<ForecastInput> = {}): ForecastInput {
  return {
    householdId: 'hh-1',
    asOfDate: '2026-08-13',
    horizonDays: 30,
    assets: [asset()],
    cashflowEvents: [],
    protectedReserves: [],
    ...over,
  };
}

describe('runForecast — the golden case (spec 05 §2)', () => {
  /**
   * This is the example the spec uses to explain why the product exists:
   *
   *   Today 20M → 15 Aug rent −25M → −5M → 20 Aug salary +30M → 25M
   *
   * The month ENDS positive at 25M. A single end-of-period total would say
   * everything is fine. The household is actually 5M short on the 15th. That
   * gap is the entire reason for a day-by-day running balance.
   */
  it('surfaces a mid-month shortfall that an end-of-period total would hide', () => {
    const result = runForecast(
      input({
        assets: [asset({ value: 20 * M })],
        cashflowEvents: [
          event({
            id: 'rent',
            name: 'Tien nha',
            direction: 'outgoing',
            requirement: 'required',
            amount: 25 * M,
            expectedDate: '2026-08-15',
          }),
          event({
            id: 'salary',
            name: 'Luong',
            direction: 'incoming',
            requirement: null,
            certainty: 'confirmed',
            amount: 30 * M,
            expectedDate: '2026-08-20',
          }),
        ],
      }),
    );

    expect(result.startingLiquidBalance).toBe(20 * M);
    expect(result.lowestProjectedBalance).toBe(-5 * M);
    expect(result.lowestProjectedBalanceDate).toBe('2026-08-15');
    expect(result.endingProjectedBalance).toBe(25 * M);
    // The obligation could not be met on the day it fell due.
    expect(result.obligationsCovered).toBe(false);
  });
});

describe('runForecast — starting balance', () => {
  it('counts only usable_now assets', () => {
    const result = runForecast(
      input({
        assets: [
          asset({ assetId: 'a1', value: 10 * M, liquidity: 'usable_now' }),
          asset({
            assetId: 'a2',
            value: 500 * M,
            liquidity: 'not_immediately_usable',
          }),
          asset({ assetId: 'a3', value: 900 * M, liquidity: 'long_term' }),
        ],
      }),
    );

    // Savings and long-term holdings are net worth, not cash flow.
    expect(result.startingLiquidBalance).toBe(10 * M);
    expect(result.usableNowAssetCount).toBe(1);
  });

  it.each([
    [
      'personal_private nature',
      { financialNature: 'personal_private' as const },
    ],
    ['private visibility', { visibilityLevel: 'private' as const }],
  ])('excludes an asset with %s', (_label, patch) => {
    const result = runForecast(
      input({
        assets: [
          asset({ assetId: 'a1', value: 10 * M }),
          asset({ assetId: 'a2', value: 99 * M, ...patch }),
        ],
      }),
    );

    expect(result.startingLiquidBalance).toBe(10 * M);
  });

  it('includes personal_included money that the owner chose to count', () => {
    const result = runForecast(
      input({
        assets: [
          asset({ assetId: 'a1', value: 10 * M }),
          asset({
            assetId: 'a2',
            value: 5 * M,
            financialNature: 'personal_included',
          }),
        ],
      }),
    );

    expect(result.startingLiquidBalance).toBe(15 * M);
  });
});

describe('runForecast — certainty and requirement', () => {
  it('does NOT bank estimated incoming, but still shows it', () => {
    const result = runForecast(
      input({
        cashflowEvents: [
          event({
            id: 'bonus',
            direction: 'incoming',
            requirement: null,
            certainty: 'estimated',
            amount: 50 * M,
            expectedDate: '2026-08-20',
          }),
        ],
      }),
    );

    expect(result.endingProjectedBalance).toBe(20 * M);
    const occurrence = result.timeline.find((o) => o.sourceEventId === 'bonus');
    expect(occurrence?.countedInBalance).toBe(false);
    expect(occurrence?.exclusionReason).toBe('estimated_incoming');
    expect(result.totals.estimatedIncomingAmountExcluded).toBe(50 * M);
  });

  it('banks estimated incoming when explicitly asked to', () => {
    const result = runForecast(
      input({
        cashflowEvents: [
          event({
            direction: 'incoming',
            requirement: null,
            certainty: 'estimated',
            amount: 50 * M,
            expectedDate: '2026-08-20',
          }),
        ],
        options: { includeEstimatedIncoming: true },
      }),
    );

    expect(result.endingProjectedBalance).toBe(70 * M);
  });

  // Discretionary spending shouldn't make the household look like it can't pay
  // its bills.
  it('planned outgoing moves the balance but does not break obligation coverage', () => {
    const result = runForecast(
      input({
        assets: [asset({ value: 10 * M })],
        cashflowEvents: [
          event({
            id: 'holiday',
            direction: 'outgoing',
            requirement: 'planned',
            amount: 30 * M,
            expectedDate: '2026-08-20',
          }),
        ],
      }),
    );

    expect(result.lowestProjectedBalance).toBe(-20 * M);
    expect(result.obligationsCovered).toBe(true);
  });

  it('required outgoing breaks obligation coverage', () => {
    const result = runForecast(
      input({
        assets: [asset({ value: 10 * M })],
        cashflowEvents: [
          event({
            direction: 'outgoing',
            requirement: 'required',
            amount: 30 * M,
            expectedDate: '2026-08-20',
          }),
        ],
      }),
    );

    expect(result.obligationsCovered).toBe(false);
  });
});

describe('runForecast — status handling', () => {
  it.each([['completed'], ['cancelled']] as const)(
    'excludes a %s event entirely',
    (status) => {
      const result = runForecast(
        input({
          cashflowEvents: [event({ status, amount: 5 * M })],
        }),
      );

      expect(result.timeline).toHaveLength(0);
      expect(result.endingProjectedBalance).toBe(20 * M);
    },
  );

  it('shows a postponed event but does not let it move the balance', () => {
    const result = runForecast(
      input({
        cashflowEvents: [event({ status: 'postponed', amount: 5 * M })],
      }),
    );

    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0].countedInBalance).toBe(false);
    expect(result.endingProjectedBalance).toBe(20 * M);
  });

  it('counts a pending_confirmation event', () => {
    const result = runForecast(
      input({
        cashflowEvents: [
          event({ status: 'pending_confirmation', amount: 5 * M }),
        ],
      }),
    );

    expect(result.endingProjectedBalance).toBe(15 * M);
  });

  it('excludes a private event and counts it as excluded', () => {
    const result = runForecast(
      input({
        cashflowEvents: [event({ visibilityLevel: 'private', amount: 5 * M })],
      }),
    );

    expect(result.excludedPrivateRecordCount).toBe(1);
    expect(result.endingProjectedBalance).toBe(20 * M);
  });
});

describe('runForecast — day series', () => {
  it('emits one day per calendar day, inclusive of both ends', () => {
    const result = runForecast(input({ horizonDays: 30 }));

    expect(result.days).toHaveLength(31);
    expect(result.days[0].date).toBe('2026-08-13');
    expect(result.days[30].date).toBe('2026-09-12');
    expect(result.horizonEndDate).toBe('2026-09-12');
  });

  it('chains each day’s opening balance from the previous close', () => {
    const result = runForecast(
      input({
        cashflowEvents: [
          event({ amount: 3 * M, expectedDate: '2026-08-15' }),
          event({
            id: 'cf-2',
            direction: 'incoming',
            requirement: null,
            amount: 7 * M,
            expectedDate: '2026-08-20',
          }),
        ],
      }),
    );

    for (let i = 1; i < result.days.length; i += 1) {
      expect(result.days[i].openingBalance).toBe(
        result.days[i - 1].closingBalance,
      );
    }
  });

  it('includes an event on the horizon end and excludes the next day', () => {
    const inside = runForecast(
      input({ cashflowEvents: [event({ expectedDate: '2026-09-12' })] }),
    );
    const outside = runForecast(
      input({ cashflowEvents: [event({ expectedDate: '2026-09-13' })] }),
    );

    expect(inside.timeline).toHaveLength(1);
    expect(outside.timeline).toHaveLength(0);
  });

  // We don't know the intraday order, so assuming income lands first would hide
  // a real shortfall.
  it('orders same-day outgoing before incoming', () => {
    const result = runForecast(
      input({
        assets: [asset({ value: 20 * M })],
        cashflowEvents: [
          event({ id: 'rent', amount: 25 * M, expectedDate: '2026-08-15' }),
          event({
            id: 'salary',
            direction: 'incoming',
            requirement: null,
            amount: 30 * M,
            expectedDate: '2026-08-15',
          }),
        ],
      }),
    );

    expect(result.timeline[0].sourceEventId).toBe('rent');
    expect(result.endingProjectedBalance).toBe(25 * M);
  });
});

describe('runForecast — reserve and assumptions', () => {
  it('flags the reserve as breached when the low point dips below it', () => {
    const result = runForecast(
      input({
        assets: [asset({ value: 50 * M })],
        protectedReserves: [
          { id: 'r1', name: 'Quy an toan', amount: 40 * M, status: 'active' },
        ],
        cashflowEvents: [event({ amount: 20 * M, expectedDate: '2026-08-20' })],
      }),
    );

    expect(result.protectedReserveAmount).toBe(40 * M);
    expect(result.lowestProjectedBalance).toBe(30 * M);
    expect(result.reserveProtected).toBe(false);
  });

  it('ignores archived reserves', () => {
    const result = runForecast(
      input({
        protectedReserves: [
          { id: 'r1', name: 'Old', amount: 40 * M, status: 'archived' },
        ],
      }),
    );

    expect(result.protectedReserveAmount).toBe(0);
    expect(result.assumptions).toContainEqual({ code: 'no_reserve_declared' });
  });

  // The client renders all copy; the backend must never emit a sentence.
  it('emits assumption CODES, never localized text', () => {
    const result = runForecast(
      input({
        cashflowEvents: [
          event({
            direction: 'incoming',
            requirement: null,
            certainty: 'estimated',
            amount: 5 * M,
          }),
          event({ id: 'p', visibilityLevel: 'private', amount: 1 * M }),
        ],
      }),
    );

    expect(result.assumptions.length).toBeGreaterThan(0);
    for (const assumption of result.assumptions) {
      expect(typeof assumption.code).toBe('string');
      if (typeof assumption.value === 'string') {
        // No Vietnamese diacritics — i.e. not user-facing copy.
        expect(assumption.value).not.toMatch(/[À-ỹ]/);
      }
    }
    expect(result.assumptions.map((a) => a.code)).toEqual(
      expect.arrayContaining([
        'horizon_days',
        'estimated_incoming_excluded',
        'private_records_excluded',
      ]),
    );
  });

  it('flags stale asset values without excluding them', () => {
    const result = runForecast(
      input({
        assets: [
          asset({
            assetId: 'fresh',
            value: 5 * M,
            valueUpdatedAt: '2026-08-10',
          }),
          asset({
            assetId: 'stale',
            value: 5 * M,
            valueUpdatedAt: '2026-01-01',
          }),
        ],
      }),
    );

    expect(result.staleAssetIds).toEqual(['stale']);
    expect(result.startingLiquidBalance).toBe(10 * M);
  });

  it('reports the next inflow it is willing to bank on', () => {
    const result = runForecast(
      input({
        cashflowEvents: [
          event({
            id: 'maybe',
            direction: 'incoming',
            requirement: null,
            certainty: 'estimated',
            amount: 9 * M,
            expectedDate: '2026-08-16',
          }),
          event({
            id: 'salary',
            direction: 'incoming',
            requirement: null,
            certainty: 'confirmed',
            amount: 30 * M,
            expectedDate: '2026-08-20',
          }),
        ],
      }),
    );

    // The estimated one is earlier but is not banked on.
    expect(result.nextSufficientlyCertainInflow).toEqual({
      date: '2026-08-20',
      amount: 30 * M,
      sourceEventId: 'salary',
    });
  });
});

describe('runForecast — recurrence', () => {
  it('expands a monthly series across the horizon', () => {
    const result = runForecast(
      input({
        horizonDays: 60,
        assets: [asset({ value: 100 * M })],
        cashflowEvents: [
          event({
            amount: 10 * M,
            expectedDate: '2026-08-15',
            recurrence: 'monthly',
          }),
        ],
      }),
    );

    // 60 days from 13 Aug ends 12 Oct, so the 15 Oct occurrence falls outside.
    expect(result.timeline.map((o) => o.date)).toEqual([
      '2026-08-15',
      '2026-09-15',
    ]);
  });

  it('never writes anything — occurrences are objects, not rows', () => {
    // Structural guarantee: the engine takes plain data and returns plain data.
    // Nothing here can persist, which is the §2.15 requirement made literal.
    const result = runForecast(
      input({
        cashflowEvents: [
          event({
            recurrence: 'weekly',
            amount: 1 * M,
            expectedDate: '2026-08-15',
          }),
        ],
      }),
    );

    expect(result.timeline.filter((o) => o.isVirtual).length).toBeGreaterThan(
      0,
    );
    expect(
      result.timeline.every((o) => typeof o.occurrenceKey === 'string'),
    ).toBe(true);
  });
});
