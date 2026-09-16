import {
  buildAssetValueChange,
  buildAssetValueChangeTotal,
} from './value-change';

const M = 1_000_000;

describe('buildAssetValueChange', () => {
  it('reports a gain against the previous point', () => {
    expect(buildAssetValueChange('2026-09-14', 100 * M, 102 * M)).toEqual({
      previousDate: '2026-09-14',
      previousValue: 100 * M,
      delta: 2 * M,
      deltaPercent: 2,
    });
  });

  it('reports a loss with a signed delta', () => {
    const change = buildAssetValueChange('2026-09-14', 100 * M, 95 * M);
    expect(change?.delta).toBe(-5 * M);
    expect(change?.deltaPercent).toBe(-5);
  });

  /**
   * The baseline is the last RECORDED point, not yesterday: markets close at
   * weekends and the nightly job can miss a day. The date travels so the UI can
   * say which day it is comparing against.
   */
  it('keeps the baseline date even when it is days old', () => {
    expect(
      buildAssetValueChange('2026-09-11', 100 * M, 101 * M)?.previousDate,
    ).toBe('2026-09-11');
  });

  /**
   * Deliberately unlike `buildGoalProgressChange`, which stays silent when
   * nothing moved: that one feeds an explanation, this one fills a fixed slot
   * on a card, where a blank reads as "we don't know".
   */
  it('still reports a day that did not move', () => {
    expect(buildAssetValueChange('2026-09-14', 100 * M, 100 * M)).toEqual({
      previousDate: '2026-09-14',
      previousValue: 100 * M,
      delta: 0,
      deltaPercent: 0,
    });
  });

  it('gives no percent when the baseline was zero', () => {
    const change = buildAssetValueChange('2026-09-14', 0, 5 * M);
    expect(change?.delta).toBe(5 * M);
    // 0 → 5tr is not "+100%", it is simply new.
    expect(change?.deltaPercent).toBeNull();
  });

  it('says nothing without a baseline', () => {
    expect(buildAssetValueChange(null, null, 100 * M)).toBeNull();
    expect(buildAssetValueChange('2026-09-14', null, 100 * M)).toBeNull();
    expect(buildAssetValueChange(null, 100 * M, 100 * M)).toBeNull();
  });
});

describe('buildAssetValueChangeTotal', () => {
  const change = (previousDate: string, previousValue: number, delta: number) =>
    buildAssetValueChange(previousDate, previousValue, previousValue + delta);

  it('sums the holdings that have a baseline', () => {
    const total = buildAssetValueChangeTotal([
      change('2026-09-14', 100 * M, 2 * M),
      change('2026-09-14', 300 * M, -6 * M),
    ]);
    expect(total).toMatchObject({
      delta: -4 * M,
      assetCount: 2,
      missingCount: 0,
    });
    // −4tr over the 400tr those two were worth, not over the whole portfolio.
    expect(total?.deltaPercent).toBeCloseTo(-1);
  });

  it('counts the holdings it could not measure', () => {
    const total = buildAssetValueChangeTotal([
      change('2026-09-14', 100 * M, 5 * M),
      null,
      null,
    ]);
    expect(total).toMatchObject({
      delta: 5 * M,
      assetCount: 1,
      missingCount: 2,
    });
  });

  /** The total is "since the oldest leg", so it cannot claim yesterday. */
  it('reports the oldest baseline date', () => {
    expect(
      buildAssetValueChangeTotal([
        change('2026-09-14', 100 * M, 1 * M),
        change('2026-09-11', 100 * M, 1 * M),
      ])?.previousDate,
    ).toBe('2026-09-11');
  });

  it('gives no total when the household holds nothing market-priced', () => {
    expect(buildAssetValueChangeTotal([])).toBeNull();
  });

  it('reports no percent when nothing had a baseline', () => {
    const total = buildAssetValueChangeTotal([null, null]);
    expect(total).toMatchObject({ delta: 0, assetCount: 0, missingCount: 2 });
    expect(total?.deltaPercent).toBeNull();
    expect(total?.previousDate).toBeNull();
  });
});
