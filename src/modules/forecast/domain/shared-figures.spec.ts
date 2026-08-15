import { computeLiquidityTotals } from '../../../common/utils/money-space.utils';
import { runForecast } from './forecast';
import type { ForecastInput, ForecastLiquidSource } from './forecast.types';

const M = 1_000_000;
const TODAY = '2026-08-15';

/**
 * Every shared figure must be computed over the same set of records.
 *
 * This is the test the old model could not pass. `visibility_level = 'private'`
 * and `financial_nature = 'personal_private'` removed a record from the
 * forecast and from flexible money — but NOT from the dashboard's net worth
 * (`dashboard.service.ts`), the asset summary (`assets.service.ts`) or a
 * snapshot's totals (`snapshots.service.ts`), none of which ever applied the
 * rule. Two numbers sitting next to each other on the same screen disagreed
 * about how much money the household had, and nothing documented it.
 *
 * Sharing level is now purely presentational, so the only correct answer is
 * that it changes no figure anywhere. This test exists to fail loudly if
 * anyone reintroduces an exclusion rule on one path and not the others.
 */
describe('shared figures agree with each other', () => {
  const shown: ForecastLiquidSource = {
    assetId: 'a-shown',
    name: 'VCB',
    value: 60 * M,
    liquidity: 'usable_now',
    valueUpdatedAt: TODAY,
  };

  // Identical in every respect except that the household chose not to itemize
  // it. Under the old rule this one silently vanished from the forecast.
  const folded: ForecastLiquidSource = {
    assetId: 'a-folded',
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
    protectedReserves: [],
  });

  it('counts a folded asset in the forecast, exactly like a shown one', () => {
    const both = runForecast(input([shown, folded]));

    expect(both.startingLiquidBalance).toBe(100 * M);
    expect(both.usableNowAssetCount).toBe(2);
  });

  it('gives the forecast the same liquid basis the dashboard totals do', () => {
    const assets = [shown, folded];

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
    const withBoth = runForecast(input([shown, folded]));
    const withoutFolded = runForecast(input([shown]));

    expect(withBoth.startingLiquidBalance - withoutFolded.startingLiquidBalance).toBe(
      folded.value,
    );
  });

  it('reports no records as withheld from the calculation', () => {
    const result = runForecast(input([shown, folded]));

    // `private_records_excluded` is gone from AssumptionCode. Nothing is
    // withheld, so nothing has to be disclosed as withheld.
    expect(result.assumptions.map((a) => a.code)).not.toContain(
      'private_records_excluded',
    );
  });
});
