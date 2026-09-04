import { runForecast } from './forecast';
import { walletValuesAfterOutflows } from './wallet-values-after-outflows';
import { resolveGoalCommittedAmount } from '../../goals/domain/goal-progress';
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
    value: 22 * M,
    liquidity: 'usable_now',
    type: 'bank_account',
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
    amount: 2 * M,
    expectedDate: '2026-08-15',
    recurrence: 'once',
    recurrenceEndDate: null,
    requirement: 'required',
    certainty: 'confirmed',
    status: 'expected',
    settlementAssetId: 'tcb',
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

/** The car goal from the worked example: 20tr set aside, 20tr/month pace. */
const CAR_CLAIM = [
  {
    goalId: 'car',
    priority: 'high' as const,
    allocations: [
      {
        assetId: 'tcb',
        kind: 'fixed' as const,
        role: 'contribution' as const,
        allocatedAmount: 20 * M,
        monthlyContribution: 20 * M,
      },
    ],
  },
];

describe('walletValuesAfterOutflows', () => {
  it('leaves wallets untouched when nothing is going out', () => {
    expect(walletValuesAfterOutflows(forecastOf())).toEqual(
      new Map([['tcb', 22 * M]]),
    );
  });

  it('subtracts an outflow from the wallet it settles from', () => {
    const values = walletValuesAfterOutflows(
      forecastOf({ cashflowEvents: [event({ amount: 5 * M })] }),
    );
    expect(values.get('tcb')).toBe(17 * M);
  });

  it('only touches the wallet named, leaving the others whole', () => {
    const values = walletValuesAfterOutflows(
      forecastOf({
        assets: [
          asset(),
          asset({ assetId: 'vcb', name: 'VCB', value: 30 * M }),
        ],
        cashflowEvents: [event({ amount: 5 * M, settlementAssetId: 'vcb' })],
      }),
    );
    expect(values.get('tcb')).toBe(22 * M);
    expect(values.get('vcb')).toBe(25 * M);
  });

  it('ignores incoming events — money not yet arrived backs no goal', () => {
    const values = walletValuesAfterOutflows(
      forecastOf({
        cashflowEvents: [
          event({
            direction: 'incoming',
            amount: 10 * M,
            requirement: null,
          }),
        ],
      }),
    );
    expect(values.get('tcb')).toBe(22 * M);
  });

  it('ignores outflows the forecast did not bank', () => {
    const values = walletValuesAfterOutflows(
      forecastOf({
        cashflowEvents: [event({ amount: 5 * M, status: 'postponed' })],
      }),
    );
    expect(values.get('tcb')).toBe(22 * M);
  });

  it('never lets a wallet go negative', () => {
    const values = walletValuesAfterOutflows(
      forecastOf({ cashflowEvents: [event({ amount: 40 * M })] }),
    );
    expect(values.get('tcb')).toBe(0);
  });

  it('ignores an outflow settling from a wallet the forecast did not count', () => {
    const values = walletValuesAfterOutflows(
      forecastOf({
        cashflowEvents: [event({ amount: 5 * M, settlementAssetId: 'gold' })],
      }),
    );
    expect(values.get('tcb')).toBe(22 * M);
    expect(values.has('gold')).toBe(false);
  });
});

/**
 * The worked example that motivated the change: an outflow outranks the goals
 * sharing its wallet, spending this month's contribution first and only then
 * eating into what was set aside.
 */
describe('goal money yields to an outflow, pace first', () => {
  const claim = (outflow: number) =>
    resolveGoalCommittedAmount(
      CAR_CLAIM,
      walletValuesAfterOutflows(
        forecastOf(
          outflow === 0 ? {} : { cashflowEvents: [event({ amount: outflow })] },
        ),
      ),
    );

  it('claims the whole wallet when nothing is going out', () => {
    // 20tr set aside + 2tr of free room the 20tr pace can still take.
    expect(claim(0)).toBe(22 * M);
  });

  it('spends this month’s contribution before touching what is set aside', () => {
    // The 2tr of pace is wiped out; the 20tr set aside is untouched.
    expect(claim(2 * M)).toBe(20 * M);
  });

  it('eats into what is set aside once the contribution is gone', () => {
    // Pace gone, then 3tr more comes out of the 20tr set aside.
    expect(claim(5 * M)).toBe(17 * M);
  });

  it('never reports the goals claiming more than the wallet holds', () => {
    expect(claim(40 * M)).toBe(0);
  });
});
