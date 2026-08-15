import {
  FINANCIAL_STATE_THRESHOLDS,
  deriveFinancialState,
} from './financial-state';
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
    value: 100 * M,
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
    expectedDate: '2026-08-20',
    recurrence: 'once',
    recurrenceEndDate: null,
    requirement: 'required',
    certainty: 'confirmed',
    status: 'expected',
    visibilityLevel: 'detail',
    ...over,
  };
}

function derive(over: Partial<ForecastInput> = {}) {
  const forecast = runForecast({
    householdId: 'hh-1',
    asOfDate: '2026-08-13',
    horizonDays: 30,
    assets: [asset()],
    cashflowEvents: [event()],
    protectedReserves: [],
    ...over,
  });
  return deriveFinancialState(forecast, computeFlexibleMoney(forecast));
}

describe('deriveFinancialState — incomplete', () => {
  // Absence of data is not a judgement about money.
  it('is incomplete with no liquid sources', () => {
    const result = derive({ assets: [] });
    expect(result.state).toBe('incomplete');
    expect(result.reasons).toContain('no_liquid_sources');
  });

  it('is incomplete with nothing to forecast', () => {
    const result = derive({ cashflowEvents: [] });
    expect(result.state).toBe('incomplete');
    expect(result.reasons).toContain('no_cashflow_events');
  });

  it('does NOT become incomplete merely because no reserve is declared', () => {
    const result = derive({ protectedReserves: [] });
    expect(result.reasons).toContain('no_reserve_declared');
    expect(result.state).not.toBe('incomplete');
  });
});

describe('deriveFinancialState — tight', () => {
  it('is tight when a required payment is not covered', () => {
    const result = derive({
      assets: [asset({ value: 5 * M })],
      cashflowEvents: [event({ amount: 50 * M })],
    });

    expect(result.state).toBe('tight');
    expect(result.reasons).toContain('required_payment_not_covered');
    expect(result.reasons).toContain('lowest_projected_balance_negative');
  });

  it('is tight when the reserve is materially breached', () => {
    const result = derive({
      assets: [asset({ value: 100 * M })],
      protectedReserves: [
        { id: 'r', name: 'Quy', amount: 100 * M, status: 'active' },
      ],
      // Leaves 30M against a 100M reserve → below the 0.5 breach ratio.
      cashflowEvents: [event({ amount: 70 * M })],
    });

    expect(result.state).toBe('tight');
    expect(result.reasons).toContain('reserve_significantly_breached');
  });
});

describe('deriveFinancialState — watch', () => {
  it('is watch when the forecast comes near the reserve without breaching it', () => {
    const result = derive({
      assets: [asset({ value: 100 * M })],
      protectedReserves: [
        { id: 'r', name: 'Quy', amount: 90 * M, status: 'active' },
      ],
      // Leaves 95M: above the reserve, but inside the 1.1× "near" band.
      cashflowEvents: [event({ amount: 5 * M })],
    });

    expect(result.state).toBe('watch');
    expect(result.reasons).toContain('forecast_near_reserve');
  });

  it('is watch when a single obligation is a large share of liquid money', () => {
    const result = derive({
      assets: [asset({ value: 100 * M })],
      cashflowEvents: [event({ amount: 40 * M })],
    });

    expect(result.reasons).toContain('large_payment_upcoming');
    expect(result.state).toBe('watch');
  });

  it('is watch when critical data is unconfirmed', () => {
    const result = derive({
      cashflowEvents: [
        event({ status: 'pending_confirmation', amount: 1 * M }),
      ],
    });

    expect(result.reasons).toContain('unconfirmed_critical_data');
    expect(result.state).toBe('watch');
  });

  it('is watch when too much of the liquid picture is stale', () => {
    const result = derive({
      assets: [
        asset({ assetId: 'a1', valueUpdatedAt: '2026-01-01' }),
        asset({ assetId: 'a2', valueUpdatedAt: '2026-08-13' }),
      ],
    });

    expect(result.reasons).toContain('stale_data');
    expect(result.state).toBe('watch');
  });
});

describe('deriveFinancialState — on_track and precedence', () => {
  it('is on_track when nothing fires', () => {
    const result = derive({
      assets: [asset({ value: 500 * M })],
      protectedReserves: [
        { id: 'r', name: 'Quy', amount: 20 * M, status: 'active' },
      ],
      cashflowEvents: [event({ amount: 1 * M })],
    });

    expect(result.state).toBe('on_track');
  });

  // The worst thing that is true wins the label, but nothing is hidden.
  it('reports tight over watch while keeping BOTH sets of reasons', () => {
    const result = derive({
      assets: [asset({ value: 10 * M })],
      protectedReserves: [
        { id: 'r', name: 'Quy', amount: 50 * M, status: 'active' },
      ],
      cashflowEvents: [event({ amount: 40 * M })],
    });

    expect(result.state).toBe('tight');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'required_payment_not_covered',
        'large_payment_upcoming',
      ]),
    );
  });

  it('never returns an empty reason list for a non-on_track state', () => {
    const result = derive({
      assets: [asset({ value: 5 * M })],
      cashflowEvents: [event({ amount: 50 * M })],
    });

    expect(result.state).not.toBe('on_track');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  // The backend must never emit a sentence — the client renders calm copy.
  it('returns codes only, never user-facing text', () => {
    const result = derive();

    expect(result.state).toMatch(/^(on_track|watch|tight|incomplete)$/);
    for (const reason of result.reasons) {
      expect(reason).toMatch(/^[a-z_]+$/);
    }
  });
});

describe('FINANCIAL_STATE_THRESHOLDS', () => {
  // Pinned so a threshold change is a deliberate edit with a failing test,
  // not a magic number quietly drifting.
  it('are the documented values', () => {
    expect(FINANCIAL_STATE_THRESHOLDS).toEqual({
      reserveBreachRatio: 0.5,
      nearReserveRatio: 1.1,
      flexibleMoneyLowRatio: 0.1,
      largePaymentRatio: 0.3,
      staleAssetRatio: 0.34,
    });
  });
});
