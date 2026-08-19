import {
  resolveGoalProgressAmount,
  resolvePlannedMonthlyContribution,
  sumAllocatedAgainstAsset,
} from './goal-progress';
import type { GoalAllocationInput } from './goal-progress';

const M = 1_000_000;

function values(entries: Record<string, number>): ReadonlyMap<string, number> {
  return new Map(Object.entries(entries));
}

describe('resolveGoalProgressAmount', () => {
  // The case that motivated the whole model: gold, stocks and cash all feeding
  // one "500tr by end of 2026", each contributing a different kind of share.
  // Note `vcb` — "money set aside from shared money" is just a fixed share of a
  // wallet, not a separate kind of goal.
  const mixed: GoalAllocationInput[] = [
    { assetId: 'gold', kind: 'percent', percent: 100 },
    { assetId: 'stocks', kind: 'fixed', allocatedAmount: 50 * M },
    { assetId: 'vcb', kind: 'fixed', allocatedAmount: 30 * M },
  ];

  it('sums fixed and percent allocations across several assets', () => {
    const amount = resolveGoalProgressAmount(
      mixed,
      values({ gold: 200 * M, stocks: 100 * M, vcb: 80 * M }),
    );
    expect(amount).toBe(280 * M);
  });

  it('tracks a percent allocation up when the asset appreciates', () => {
    const amount = resolveGoalProgressAmount(
      mixed,
      values({ gold: 240 * M, stocks: 100 * M, vcb: 80 * M }),
    );
    // Only the gold share moves; the two fixed claims stay put.
    expect(amount).toBe(320 * M);
  });

  it('caps a fixed allocation at the asset value when the asset falls', () => {
    // 50tr was claimed against stocks; the position is now worth 30tr, so only
    // 30tr is really there. Reporting 50tr would invent money.
    const amount = resolveGoalProgressAmount(
      mixed,
      values({ gold: 200 * M, stocks: 30 * M, vcb: 80 * M }),
    );
    expect(amount).toBe(260 * M);
  });

  it('counts a spent-down wallet as zero rather than the declared amount', () => {
    // This is how "taking money back out" works: the expense debits the wallet
    // and progress falls on the next read, with no goal-side write at all.
    const amount = resolveGoalProgressAmount(
      [{ assetId: 'vcb', kind: 'fixed', allocatedAmount: 30 * M }],
      values({ vcb: 0 }),
    );
    expect(amount).toBe(0);
  });

  it('treats a missing asset as zero instead of throwing', () => {
    const amount = resolveGoalProgressAmount(
      [{ assetId: 'sold-off', kind: 'percent', percent: 50 }],
      values({}),
    );
    expect(amount).toBe(0);
  });

  it('is zero for a goal with no allocations yet', () => {
    const amount = resolveGoalProgressAmount([], values({ gold: 200 * M }));
    expect(amount).toBe(0);
  });
});

describe('sumAllocatedAgainstAsset', () => {
  const allocations: GoalAllocationInput[] = [
    { assetId: 'stocks', kind: 'fixed', allocatedAmount: 50 * M },
    { assetId: 'stocks', kind: 'percent', percent: 25 },
    { assetId: 'gold', kind: 'percent', percent: 100 },
  ];

  it('sums only the claims against the named asset', () => {
    // 50tr fixed + 25% of 100tr = 75tr. The gold claim is irrelevant here.
    expect(sumAllocatedAgainstAsset(allocations, 'stocks', 100 * M)).toBe(
      75 * M,
    );
  });

  it('excludes the row being edited so an in-place update is not double-counted', () => {
    expect(sumAllocatedAgainstAsset(allocations, 'stocks', 100 * M, 0)).toBe(
      25 * M,
    );
  });

  it('is zero when the asset has no claims', () => {
    expect(sumAllocatedAgainstAsset(allocations, 'crypto', 100 * M)).toBe(0);
  });
});


describe('resolvePlannedMonthlyContribution', () => {
  // "10tr a month" is really "6tr out of the salary account and 4tr in cash".
  it('sums what the wallets say they put in', () => {
    expect(
      resolvePlannedMonthlyContribution([
        {
          assetId: 'vcb',
          kind: 'fixed',
          role: 'contribution',
          monthlyContribution: 6 * M,
        },
        {
          assetId: 'cash',
          kind: 'fixed',
          role: 'contribution',
          monthlyContribution: 4 * M,
        },
      ]),
    ).toBe(10 * M);
  });

  // Null, not 0: 0 is a promise to save nothing, and the pace panel would report
  // every month as kept while the projection divided by it.
  it('is null when no wallet declared an amount', () => {
    expect(
      resolvePlannedMonthlyContribution([
        { assetId: 'vcb', kind: 'fixed', role: 'contribution' },
        { assetId: 'gold', kind: 'percent', percent: 100, role: 'holding' },
      ]),
    ).toBeNull();
  });

  // A household that means "we are pausing this goal" says 0, and that is a
  // plan — distinct from never having declared one.
  it('keeps an explicit zero', () => {
    expect(
      resolvePlannedMonthlyContribution([
        {
          assetId: 'vcb',
          kind: 'fixed',
          role: 'contribution',
          monthlyContribution: 0,
        },
      ]),
    ).toBe(0);
  });

  // The pace is measured on contribution shares alone, so counting a holding
  // into the target would report a shortfall for money nobody planned to move.
  it('ignores a figure sitting on a holding', () => {
    expect(
      resolvePlannedMonthlyContribution([
        {
          assetId: 'gold',
          kind: 'percent',
          percent: 100,
          role: 'holding',
          monthlyContribution: 5 * M,
        },
      ]),
    ).toBeNull();
  });
});
