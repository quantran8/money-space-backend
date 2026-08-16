import { computeLiquidityTotals } from '../../../common/utils/money-space.utils';
import { runForecast } from './forecast';
import type { ForecastInput, ForecastLiquidSource } from './forecast.types';

const M = 1_000_000;
const TODAY = '2026-08-15';

/**
 * Every shared figure must be computed over the same set of records.
 *
 * Every stored source counts everywhere. This test fails loudly if an
 * exclusion rule is introduced on one calculation path but not the others.
 */
describe('shared figures agree with each other', () => {
  const first: ForecastLiquidSource = {
    assetId: 'a-first',
    name: 'VCB',
    value: 60 * M,
    liquidity: 'usable_now',
    valueUpdatedAt: TODAY,
  };

  const second: ForecastLiquidSource = {
    assetId: 'a-second',
    name: 'Sổ tiết kiệm',
    value: 40 * M,
    liquidity: 'usable_now',
    valueUpdatedAt: TODAY,
  };

  const input = (assets: ForecastLiquidSource[]): ForecastInput => ({
    householdId: 'hh-1',
    asOfDate: TODAY,
    horizonDays: 30,
    assets,
    cashflowEvents: [],
  });

  it('counts every asset in the forecast', () => {
    const both = runForecast(input([first, second]));

    expect(both.startingLiquidBalance).toBe(100 * M);
    expect(both.usableNowAssetCount).toBe(2);
  });

  it('gives the forecast the same liquid basis the dashboard totals do', () => {
    const assets = [first, second];

    // What `dashboard.service.ts` and `assets.service.ts` compute…
    const totals = computeLiquidityTotals(
      assets.map((a) => ({ liquidity: a.liquidity, currentValue: a.value })),
    );
    // …and what the forecast starts from.
    const forecast = runForecast(input(assets));

    expect(forecast.startingLiquidBalance).toBe(totals.usable_now);
    expect(totals.totalAssets).toBe(100 * M);
  });

  it('moves the figure by exactly the asset removed, never by more', () => {
    const withBoth = runForecast(input([first, second]));
    const withoutSecond = runForecast(input([first]));

    expect(
      withBoth.startingLiquidBalance - withoutSecond.startingLiquidBalance,
    ).toBe(second.value);
  });

  it('reports no records as withheld from the calculation', () => {
    const result = runForecast(input([first, second]));

    // `private_records_excluded` is gone from AssumptionCode. Nothing is
    // withheld, so nothing has to be disclosed as withheld.
    expect(result.assumptions.map((a) => a.code)).not.toContain(
      'private_records_excluded',
    );
  });
});
