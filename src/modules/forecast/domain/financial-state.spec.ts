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
});

describe('deriveFinancialState — watch', () => {
  it('is watch when a single obligation is a large share of liquid money', () => {
    const result = derive({
      assets: [asset({ value: 100 * M })],
      cashflowEvents: [event({ amount: 40 * M })],
    });

    expect(result.reasons).toContain('large_payment_upcoming');
    expect(result.state).toBe('watch');
  });

  /**
   * A wallet may now hold a negative balance (see the wallet-replay work). The
   * ratio test needs a positive balance to mean anything, but a household at or
   * below zero is the one MOST exposed to a required payment — the old `> 0`
   * guard skipped the reason for exactly that case.
   */
  it('still flags a large payment when the wallet is overdrawn', () => {
    const result = derive({
      assets: [asset({ value: -10 * M })],
      cashflowEvents: [event({ amount: 5 * M })],
    });

    expect(result.reasons).toContain('large_payment_upcoming');
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
      cashflowEvents: [event({ amount: 1 * M })],
    });

    expect(result.state).toBe('on_track');
  });

  // The worst thing that is true wins the label, but nothing is hidden.
  it('reports tight over watch while keeping BOTH sets of reasons', () => {
    const result = derive({
      assets: [asset({ value: 10 * M })],
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
      flexibleMoneyLowRatio: 0.1,
      largePaymentRatio: 0.3,
      staleAssetRatio: 0.34,
    });
  });
});
