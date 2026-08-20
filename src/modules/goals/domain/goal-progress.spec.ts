import {
  resolveGoalCommittedAmount,
  resolveGoalProgressAmount,
  resolvePlannedMonthlyContribution,
  resolveWalletShareByGoal,
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

/**
 * Dividing one wallet between the goals that draw on it.
 *
 * A wallet with 2tr free cannot give 2tr to each of two goals. Priority orders
 * who is served first; a tie is split by the shares the household declared.
 */
describe('resolveWalletShareByGoal', () => {
  const wallet = (over: Partial<GoalAllocationInput> = {}) => ({
    assetId: 'tcb',
    kind: 'fixed' as const,
    role: 'contribution' as const,
    allocatedAmount: 0,
    monthlyContribution: 20 * M,
    ...over,
  });
  const claim = (
    goalId: string,
    priority: 'high' | 'medium' | 'low',
    allocations: GoalAllocationInput[],
  ) => ({ goalId, priority, allocations });

  // The household's case: 22tr in the account, 20tr already set aside for goal
  // A, so 2tr is free. Both goals are `high`, split 70/30.
  it('splits a tie by the declared shares', () => {
    const shares = resolveWalletShareByGoal(
      [
        claim('a', 'high', [
          wallet({ allocatedAmount: 20 * M, sharePercent: 70 }),
        ]),
        claim('b', 'high', [wallet({ sharePercent: 30 })]),
      ],
      values({ tcb: 22 * M }),
    );
    expect(shares.get('a')?.amount).toBe(1.4 * M);
    expect(shares.get('b')?.amount).toBe(0.6 * M);
    // The property the per-goal version could not offer.
    expect(
      (shares.get('a')?.amount ?? 0) + (shares.get('b')?.amount ?? 0),
    ).toBe(2 * M);
  });

  // Priority settles it before any share is consulted: the high goal takes what
  // it needs and the low one gets what is left, which here is nothing.
  it('serves a higher priority in full before a lower one', () => {
    const shares = resolveWalletShareByGoal(
      [
        claim('a', 'high', [wallet({ sharePercent: 10 })]),
        claim('b', 'low', [wallet({ sharePercent: 90 })]),
      ],
      values({ tcb: 2 * M }),
    );
    expect(shares.get('a')?.amount).toBe(2 * M);
    expect(shares.get('b')?.amount).toBe(0);
  });

  // Enough for everyone: no tie to break, so the shares stay unused and each
  // goal simply takes the pace it declared.
  it('gives every goal its full pace when the wallet covers them all', () => {
    const shares = resolveWalletShareByGoal(
      [
        claim('a', 'high', [wallet({ sharePercent: 70 })]),
        claim('b', 'high', [wallet({ sharePercent: 30 })]),
      ],
      values({ tcb: 40 * M }),
    );
    expect(shares.get('a')?.amount).toBe(20 * M);
    expect(shares.get('b')?.amount).toBe(20 * M);
  });

  // A share bigger than the goal's own pace cannot pull more than the pace, and
  // what the cap leaves behind goes to the other goal rather than evaporating.
  it('caps each goal at its own pace and passes the remainder on', () => {
    const shares = resolveWalletShareByGoal(
      [
        claim('a', 'high', [
          wallet({ sharePercent: 90, monthlyContribution: 5 * M }),
        ]),
        claim('b', 'high', [
          wallet({ sharePercent: 10, monthlyContribution: 20 * M }),
        ]),
      ],
      values({ tcb: 15 * M }),
    );
    expect(shares.get('a')?.amount).toBe(5 * M);
    expect(shares.get('b')?.amount).toBe(10 * M);
  });

  // Nobody was asked: split in proportion to the declared paces, and say so, so
  // the UI can ask rather than present the fallback as the household's choice.
  it('falls back to splitting by pace, and flags that it did', () => {
    const shares = resolveWalletShareByGoal(
      [
        claim('a', 'high', [wallet({ monthlyContribution: 30 * M })]),
        claim('b', 'high', [wallet({ monthlyContribution: 10 * M })]),
      ],
      values({ tcb: 4 * M }),
    );
    expect(shares.get('a')?.amount).toBe(3 * M);
    expect(shares.get('b')?.amount).toBe(1 * M);
    expect(shares.get('a')?.needsShareDecision).toBe(true);
    expect(shares.get('b')?.needsShareDecision).toBe(true);
  });

  // A wallet that covers its goals is settled, not a fallback — the flag must
  // not fire just because no share was ever declared.
  it('does not ask for a decision when nothing had to be divided', () => {
    const shares = resolveWalletShareByGoal(
      [claim('a', 'high', [wallet()]), claim('b', 'high', [wallet()])],
      values({ tcb: 40 * M }),
    );
    expect(shares.get('a')?.needsShareDecision).toBe(false);
  });

  // Each wallet is divided on its own. A goal's full account must never be
  // treated as covering the pace it declared against an empty one.
  it('divides each wallet independently', () => {
    const shares = resolveWalletShareByGoal(
      [
        claim('a', 'high', [
          wallet({ assetId: 'tcb', sharePercent: 50 }),
          wallet({ assetId: 'vcb', sharePercent: 50 }),
        ]),
        claim('b', 'high', [wallet({ assetId: 'tcb', sharePercent: 50 })]),
      ],
      values({ tcb: 10 * M, vcb: 0 }),
    );
    // 10tr free on tcb, split 50/50 → 5tr each. vcb is empty and adds nothing.
    expect(shares.get('a')?.amount).toBe(5 * M);
    expect(shares.get('b')?.amount).toBe(5 * M);
  });

  // A wallet already spoken for entirely has nothing to divide.
  it('gives nothing when the wallet is fully claimed', () => {
    const shares = resolveWalletShareByGoal(
      [
        claim('a', 'high', [
          wallet({ allocatedAmount: 12 * M, sharePercent: 50 }),
        ]),
        claim('b', 'high', [
          wallet({ allocatedAmount: 10 * M, sharePercent: 50 }),
        ]),
      ],
      values({ tcb: 22 * M }),
    );
    expect(shares.get('a')?.amount).toBe(0);
    expect(shares.get('b')?.amount).toBe(0);
  });

  // Holdings are not fed monthly, so gold never competes for a wallet's room.
  it('ignores holding shares entirely', () => {
    const shares = resolveWalletShareByGoal(
      [
        claim('a', 'high', [
          wallet({
            assetId: 'gold',
            role: 'holding',
            monthlyContribution: null,
          }),
        ]),
      ],
      values({ gold: 100 * M }),
    );
    expect(shares.get('a')?.amount).toBe(0);
  });

  // The invariant that made this rewrite necessary: across every goal, the
  // amounts handed out can never exceed what the wallet actually holds free.
  it('never hands out more than the wallet holds free', () => {
    for (const free of [0, 1 * M, 2 * M, 7 * M, 40 * M, 100 * M]) {
      const shares = resolveWalletShareByGoal(
        [
          claim('a', 'high', [wallet({ sharePercent: 70 })]),
          claim('b', 'high', [wallet({ sharePercent: 30 })]),
          claim('c', 'medium', [wallet({ sharePercent: 100 })]),
          claim('d', 'low', [wallet()]),
        ],
        values({ tcb: free }),
      );
      const total = ['a', 'b', 'c', 'd'].reduce(
        (sum, id) => sum + (shares.get(id)?.amount ?? 0),
        0,
      );
      expect(total).toBeLessThanOrEqual(free);
    }
  });
});

/**
 * Liquid money the goals have already spoken for — the dashboard's
 * "đã có nhiệm vụ".
 *
 * The trap this exists to avoid is double-counting: money already set aside is
 * also money a monthly pace would otherwise claim again.
 */
describe('resolveGoalCommittedAmount', () => {
  const wallet = (over: Partial<GoalAllocationInput> = {}) => ({
    assetId: 'tcb',
    kind: 'fixed' as const,
    role: 'contribution' as const,
    allocatedAmount: 0,
    monthlyContribution: 20 * M,
    ...over,
  });
  const claim = (
    goalId: string,
    priority: 'high' | 'medium' | 'low',
    allocations: GoalAllocationInput[],
  ) => ({ goalId, priority, allocations });

  // The reported case. 28.8tr in the account: 20tr already behind the goal, and
  // a 20tr pace that can only draw the 8.8tr still free — the rest of that pace
  // would have to come out of the 20tr already counted.
  it('adds this month’s pace only from what is still free', () => {
    expect(
      resolveGoalCommittedAmount(
        [claim('a', 'high', [wallet({ allocatedAmount: 20 * M })])],
        values({ tcb: 28.8 * M }),
      ),
    ).toBeCloseTo(28.8 * M);
  });

  /**
   * A percent claim must keep the SAME basis in both halves of the sum.
   *
   * The reported case: tcb holds 28,8tr, a `percent: 90` contribution claim, a
   * 20tr pace, and a 2tr bill scheduled against the wallet. The caller lowers
   * the wallet to 26,8tr and passes the UNSPENT 28,8tr as `percentBasis`.
   *
   * The set-aside half used to drop that basis and re-derive the claim against
   * the lowered value — 90% of 26,8 = 24,12tr instead of 90% of 28,8 = 25,92tr —
   * while the pace half honoured it. The two halves were then measuring
   * different things, and the 1,8tr difference surfaced on the dashboard as
   * flexible money that did not exist: every đồng of the wallet was either goal
   * money or the bill.
   */
  it('keeps the percent basis in the set-aside half, not just the pace half', () => {
    const claims = [
      claim('a', 'medium', [
        wallet({ kind: 'percent', percent: 90, allocatedAmount: null }),
      ]),
    ];
    const committed = resolveGoalCommittedAmount(
      claims,
      values({ tcb: 26.8 * M }),
      values({ tcb: 28.8 * M }),
    );
    // 25.92 set aside + 0.88 of pace in the room left = the whole wallet.
    expect(committed).toBeCloseTo(26.8 * M);
    // Which is what makes flexible money read 0, not 1.8tr.
    expect(26.8 * M - committed).toBeCloseTo(0);
  });

  // Nothing set aside yet: the whole pace comes out of free money.
  it('counts the full pace when nothing is set aside', () => {
    expect(
      resolveGoalCommittedAmount(
        [claim('a', 'high', [wallet()])],
        values({ tcb: 50 * M }),
      ),
    ).toBe(20 * M);
  });

  // A goal with money behind it but no pace is committed for exactly that money.
  it('counts money set aside with no pace declared', () => {
    expect(
      resolveGoalCommittedAmount(
        [
          claim('a', 'high', [
            wallet({ allocatedAmount: 15 * M, monthlyContribution: null }),
          ]),
        ],
        values({ tcb: 50 * M }),
      ),
    ).toBe(15 * M);
  });

  // Assets the caller left out are not liquid money, so a goal backed by gold
  // adds nothing to a figure about liquid money.
  it('ignores assets outside the value map', () => {
    expect(
      resolveGoalCommittedAmount(
        [
          claim('a', 'high', [
            wallet({
              assetId: 'gold',
              role: 'holding',
              allocatedAmount: 100 * M,
            }),
          ]),
        ],
        values({ tcb: 50 * M }),
      ),
    ).toBe(0);
  });

  // Two goals on one wallet are still bounded by the one wallet.
  it('never counts more than the wallet holds', () => {
    const committed = resolveGoalCommittedAmount(
      [
        claim('a', 'high', [wallet({ allocatedAmount: 10 * M })]),
        claim('b', 'high', [wallet({ allocatedAmount: 5 * M })]),
      ],
      values({ tcb: 22 * M }),
    );
    expect(committed).toBeLessThanOrEqual(22 * M);
  });

  // The invariant the whole design turns on: committed money can never exceed
  // the money it is committed OUT OF, whatever the paces say.
  it('never exceeds the liquid total, at any balance', () => {
    for (const balance of [0, 5 * M, 20 * M, 28.8 * M, 60 * M, 200 * M]) {
      const committed = resolveGoalCommittedAmount(
        [
          claim('a', 'high', [
            wallet({ allocatedAmount: 20 * M, monthlyContribution: 20 * M }),
          ]),
          claim('b', 'medium', [wallet({ monthlyContribution: 40 * M })]),
        ],
        values({ tcb: balance }),
      );
      expect(committed).toBeLessThanOrEqual(balance);
    }
  });
});
