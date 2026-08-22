import { runForecast } from './forecast';
import { findAtRiskOccurrences, findNewlyAtRisk } from './at-risk-occurrences';
import { buildSyntheticEvent } from './what-if';
import type {
  ForecastCashflowEvent,
  ForecastInput,
  ForecastLiquidSource,
} from './forecast.types';

const M = 1_000_000;

function asset(over: Partial<ForecastLiquidSource> = {}): ForecastLiquidSource {
  return {
    assetId: 'tcb',
    name: 'TCB',
    value: 10 * M,
    liquidity: 'usable_now',
    valueUpdatedAt: '2026-08-13',
    ...over,
  };
}

function event(
  over: Partial<ForecastCashflowEvent> = {},
): ForecastCashflowEvent {
  return {
    id: 'cf',
    name: 'Bill',
    direction: 'outgoing',
    amount: 2 * M,
    expectedDate: '2026-08-15',
    recurrence: 'once',
    recurrenceEndDate: null,
    requirement: 'required',
    certainty: 'confirmed',
    status: 'expected',
    ...over,
  };
}

function forecastOf(over: Partial<ForecastInput> = {}) {
  return runForecast({
    householdId: 'hh-1',
    asOfDate: '2026-08-13',
    horizonDays: 30,
    assets: [asset()],
    cashflowEvents: [],
    ...over,
  });
}

describe('findAtRiskOccurrences', () => {
  it('finds nothing when the balance covers everything', () => {
    const forecast = forecastOf({ cashflowEvents: [event({ amount: 5 * M })] });
    expect(findAtRiskOccurrences(forecast)).toEqual([]);
  });

  it('names the item the balance cannot cover, and by how much', () => {
    const forecast = forecastOf({
      cashflowEvents: [event({ id: 'rent', name: 'Tiền nhà', amount: 12 * M })],
    });

    const atRisk = findAtRiskOccurrences(forecast);

    expect(atRisk).toHaveLength(1);
    expect(atRisk[0]).toMatchObject({
      name: 'Tiền nhà',
      amount: 12 * M,
      // 10tr on hand, 12tr due → 2tr missing.
      shortfall: 2 * M,
      balanceAfter: -2 * M,
    });
  });

  it('agrees with the forecast about whether anything is short', () => {
    const covered = forecastOf({ cashflowEvents: [event({ amount: 5 * M })] });
    const short = forecastOf({ cashflowEvents: [event({ amount: 12 * M })] });

    expect(covered.obligationsCovered).toBe(true);
    expect(findAtRiskOccurrences(covered)).toHaveLength(0);
    expect(short.obligationsCovered).toBe(false);
    expect(findAtRiskOccurrences(short).length).toBeGreaterThan(0);
  });

  it('counts incoming money before the items that follow it', () => {
    const forecast = forecastOf({
      cashflowEvents: [
        event({
          id: 'salary',
          direction: 'incoming',
          requirement: null,
          amount: 20 * M,
          expectedDate: '2026-08-14',
        }),
        event({ id: 'rent', amount: 12 * M, expectedDate: '2026-08-20' }),
      ],
    });

    // The salary lands first, so the rent is covered after all.
    expect(findAtRiskOccurrences(forecast)).toEqual([]);
  });

  /**
   * Planned outflows are never REPORTED — discretionary spending running the
   * balance low is not an obligation going unmet…
   */
  it('never reports a planned outflow as at risk', () => {
    const forecast = forecastOf({
      cashflowEvents: [event({ amount: 12 * M, requirement: 'planned' })],
    });
    expect(findAtRiskOccurrences(forecast)).toEqual([]);
  });

  /**
   * …but they still SPEND the money. A planned purchase that empties the account
   * leaves the rent just as unpayable, and what-if's own hypothetical spend is
   * `planned` by construction — if it did not move the balance here, the feature
   * could never answer "what does this break?".
   */
  it('still lets a planned outflow put a required one at risk', () => {
    const forecast = forecastOf({
      cashflowEvents: [
        event({
          id: 'shopping',
          amount: 6 * M,
          requirement: 'planned',
          expectedDate: '2026-08-14',
        }),
        event({
          id: 'rent',
          name: 'Tiền nhà',
          amount: 8 * M,
          expectedDate: '2026-08-20',
        }),
      ],
    });

    const atRisk = findAtRiskOccurrences(forecast);

    // 10tr − 6tr planned = 4tr, so the 8tr rent is 4tr short.
    expect(atRisk).toHaveLength(1);
    expect(atRisk[0].name).toBe('Tiền nhà');
    expect(atRisk[0].shortfall).toBe(4 * M);
  });

  it('reports later items as fully short once the balance is gone', () => {
    const forecast = forecastOf({
      cashflowEvents: [
        event({
          id: 'a',
          name: 'A',
          amount: 12 * M,
          expectedDate: '2026-08-15',
        }),
        event({
          id: 'b',
          name: 'B',
          amount: 3 * M,
          expectedDate: '2026-08-16',
        }),
      ],
    });

    const atRisk = findAtRiskOccurrences(forecast);

    expect(atRisk).toHaveLength(2);
    expect(atRisk[0].shortfall).toBe(2 * M);
    // Nothing left by the time B is due, so all of it is uncovered.
    expect(atRisk[1].shortfall).toBe(3 * M);
  });
});

describe('findNewlyAtRisk', () => {
  const input: Partial<ForecastInput> = {
    cashflowEvents: [event({ id: 'rent', name: 'Tiền nhà', amount: 8 * M })],
  };

  it('blames a spend only for what it actually breaks', () => {
    const before = forecastOf(input);
    const after = runForecast({
      householdId: 'hh-1',
      asOfDate: '2026-08-13',
      horizonDays: 30,
      assets: [asset()],
      cashflowEvents: input.cashflowEvents ?? [],
      options: {
        syntheticEvents: [
          buildSyntheticEvent({ amount: 5 * M, plannedDate: '2026-08-14' }),
        ],
        includePlannedOutgoing: true,
      },
    });

    // 10tr covers the 8tr rent on its own; adding a 5tr spend first does not.
    expect(findAtRiskOccurrences(before)).toEqual([]);
    const newly = findNewlyAtRisk(before, after);
    expect(newly).toHaveLength(1);
    expect(newly[0].name).toBe('Tiền nhà');
  });

  it('does not blame a spend for an item that was already short', () => {
    const alreadyShort: Partial<ForecastInput> = {
      cashflowEvents: [event({ id: 'rent', amount: 15 * M })],
    };
    const before = forecastOf(alreadyShort);
    const after = runForecast({
      householdId: 'hh-1',
      asOfDate: '2026-08-13',
      horizonDays: 30,
      assets: [asset()],
      cashflowEvents: alreadyShort.cashflowEvents ?? [],
      options: {
        syntheticEvents: [
          buildSyntheticEvent({ amount: 1 * M, plannedDate: '2026-08-14' }),
        ],
        includePlannedOutgoing: true,
      },
    });

    expect(findAtRiskOccurrences(before)).toHaveLength(1);
    expect(findNewlyAtRisk(before, after)).toEqual([]);
  });
});
