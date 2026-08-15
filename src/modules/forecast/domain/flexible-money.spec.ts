import { computeFlexibleMoney } from './flexible-money';
import { runForecast } from './forecast';
import type {
  ForecastCashflowEvent,
  ForecastInput,
  ForecastLiquidSource,
} from './forecast.types';

const M = 1_000_000;

function asset(over: Partial<ForecastLiquidSource> = {}): ForecastLiquidSource {
  return {
    assetId: 'a1',
    name: 'VCB',
    value: 50 * M,
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
    id: 'cf',
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

function compute(over: Partial<ForecastInput> = {}) {
  return computeFlexibleMoney(
    runForecast({
      householdId: 'hh-1',
      asOfDate: '2026-08-13',
      horizonDays: 30,
      assets: [asset()],
      cashflowEvents: [],
      protectedReserves: [],
      ...over,
    }),
  );
}

describe('computeFlexibleMoney — the conservative form (05 §3)', () => {
  it('subtracts the reserve and the obligations due before the next inflow', () => {
    const result = compute({
      assets: [asset({ value: 50 * M })],
      protectedReserves: [
        { id: 'r', name: 'Quy an toan', amount: 20 * M, status: 'active' },
      ],
      cashflowEvents: [
        event({ id: 'rent', amount: 15 * M, expectedDate: '2026-08-16' }),
        event({
          id: 'salary',
          direction: 'incoming',
          requirement: null,
          amount: 30 * M,
          expectedDate: '2026-08-25',
        }),
        // Falls AFTER the next inflow, so it isn't in the conservative window.
        event({ id: 'later', amount: 8 * M, expectedDate: '2026-08-28' }),
      ],
    });

    // 50 − 20 reserve − 15 due before payday = 15
    expect(result.flexibleMoneyToday).toBe(15 * M);
    expect(result.requiredOutflowsBeforeNextInflow).toBe(15 * M);
    expect(result.nextSufficientlyCertainInflow).toEqual({
      date: '2026-08-25',
      amount: 30 * M,
    });
  });

  // We can't know whether the salary lands before or after that day's rent.
  it('includes an outflow landing exactly on the inflow date', () => {
    const result = compute({
      assets: [asset({ value: 50 * M })],
      cashflowEvents: [
        event({ id: 'rent', amount: 10 * M, expectedDate: '2026-08-25' }),
        event({
          id: 'salary',
          direction: 'incoming',
          requirement: null,
          amount: 30 * M,
          expectedDate: '2026-08-25',
        }),
      ],
    });

    expect(result.requiredOutflowsBeforeNextInflow).toBe(10 * M);
  });

  it('falls back to the whole horizon when no inflow is banked on', () => {
    const result = compute({
      assets: [asset({ value: 50 * M })],
      cashflowEvents: [
        event({ id: 'a', amount: 5 * M, expectedDate: '2026-08-16' }),
        event({ id: 'b', amount: 7 * M, expectedDate: '2026-09-01' }),
      ],
    });

    expect(result.requiredOutflowsBeforeNextInflow).toBe(12 * M);
    expect(result.assumptions.map((a) => a.code)).toContain(
      'no_confirmed_inflow_in_horizon',
    );
  });

  it('ignores planned outflows in the conservative form', () => {
    const result = compute({
      assets: [asset({ value: 50 * M })],
      cashflowEvents: [
        event({ id: 'holiday', requirement: 'planned', amount: 20 * M }),
      ],
    });

    // Only obligations reduce what is "already spoken for".
    expect(result.requiredOutflowsBeforeNextInflow).toBe(0);
    expect(result.flexibleMoneyToday).toBe(50 * M);
  });
});

describe('computeFlexibleMoney — negative is the signal', () => {
  /**
   * The single most important rule in this file. If someone ever "tidies" this
   * with Math.max(0, …), the product stops being able to say
   * "you've committed more than you hold" — the exact thing it exists for.
   */
  it('goes negative and is NOT clamped to zero', () => {
    const result = compute({
      assets: [asset({ value: 30 * M })],
      protectedReserves: [
        { id: 'r', name: 'Quy an toan', amount: 100 * M, status: 'active' },
      ],
    });

    expect(result.flexibleMoneyToday).toBe(-70 * M);
    expect(result.flexibleMoneyHorizon).toBe(-70 * M);
  });
});

describe('computeFlexibleMoney — the horizon form', () => {
  it('is the lowest projected balance minus the reserve', () => {
    const result = compute({
      assets: [asset({ value: 50 * M })],
      protectedReserves: [
        { id: 'r', name: 'Quy an toan', amount: 10 * M, status: 'active' },
      ],
      cashflowEvents: [event({ amount: 30 * M, expectedDate: '2026-08-20' })],
    });

    expect(result.lowestProjectedBalance).toBe(20 * M);
    expect(result.flexibleMoneyHorizon).toBe(10 * M);
  });
});

describe('computeFlexibleMoney — assumptions', () => {
  it('carries machine-readable codes, never localized copy', () => {
    const result = compute({
      cashflowEvents: [
        event({
          direction: 'incoming',
          requirement: null,
          certainty: 'estimated',
          amount: 9 * M,
        }),
      ],
    });

    expect(result.assumptions.length).toBeGreaterThan(0);
    for (const assumption of result.assumptions) {
      expect(assumption.code).toMatch(/^[a-z_]+$/);
      if (typeof assumption.value === 'string') {
        expect(assumption.value).not.toMatch(/[À-ỹ]/);
      }
    }
  });

  it('exposes which outflows it subtracted, for "how was this calculated"', () => {
    const result = compute({
      assets: [asset({ value: 50 * M })],
      cashflowEvents: [event({ id: 'rent', amount: 5 * M })],
    });

    expect(result.consideredOutflowKeys).toEqual(['rent@2026-08-15']);
  });
});
