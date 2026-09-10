import {
  settleMonthlyContributions,
  type SettlementAllocation,
} from './settle-contributions';

const M = 1_000_000;

function share(over: Partial<SettlementAllocation> = {}): SettlementAllocation {
  return {
    allocationId: 'alloc-tcb',
    goalId: 'goal-car',
    assetId: 'tcb',
    allocatedAmount: 20 * M,
    monthlyContribution: 10 * M,
    sharePercent: null,
    priority: 'high',
    ...over,
  };
}

describe('settleMonthlyContributions', () => {
  // The worked example: TCB holds 30tr, 20tr of it is already the car's, and
  // the household means to add 10tr a month.
  describe('one wallet, one goal — 20tr held, 10tr a month', () => {
    it('credits the full pace when the wallet grew by it', () => {
      const [result] = settleMonthlyContributions(
        [share()],
        new Map([['tcb', 40 * M]]),
      );
      expect(result.closing).toBe(30 * M);
      expect(result.actual).toBe(10 * M);
      expect(result.shortOnWallet).toBe(false);
    });

    // Money the goals never claimed is the household's to spend. A wallet that
    // ends at 35tr still covers the 30tr aim, so the 5tr that went was never
    // the goal's — reporting a shortfall here would be inventing one.
    it('ignores spending that never reached the promised money', () => {
      const [result] = settleMonthlyContributions(
        [share()],
        new Map([['tcb', 35 * M]]),
      );
      expect(result.closing).toBe(30 * M);
      expect(result.actual).toBe(10 * M);
      expect(result.shortOnWallet).toBe(false);
    });

    // Spending that reaches THROUGH the unpromised money costs the goal exactly
    // what it took, and no more.
    it('reports the shortfall when the wallet could not cover the aim', () => {
      const [result] = settleMonthlyContributions(
        [share()],
        new Map([['tcb', 26 * M]]),
      );
      expect(result.closing).toBe(26 * M);
      expect(result.actual).toBe(6 * M);
      expect(result.shortOnWallet).toBe(true);
    });

    // Never clamped: eating into money the goal had already banked is the
    // signal, and a floor at zero would hide it.
    it('goes negative when the household spent into what the goal held', () => {
      const [result] = settleMonthlyContributions(
        [share()],
        new Map([['tcb', 18 * M]]),
      );
      expect(result.closing).toBe(18 * M);
      expect(result.actual).toBe(-2 * M);
    });
  });

  // A share with no declared pace is not abandoned: the household never
  // promised to add to it, but never released it either.
  it('holds a paceless share at what it already had', () => {
    const [result] = settleMonthlyContributions(
      [share({ monthlyContribution: null })],
      new Map([['tcb', 50 * M]]),
    );
    expect(result.target).toBe(20 * M);
    expect(result.closing).toBe(20 * M);
    expect(result.actual).toBe(0);
  });

  it('fills a high goal before a medium one when the wallet is short', () => {
    const results = settleMonthlyContributions(
      [
        share({ allocationId: 'a-car', goalId: 'goal-car', priority: 'high' }),
        share({
          allocationId: 'a-trip',
          goalId: 'goal-trip',
          priority: 'medium',
          allocatedAmount: 5 * M,
          monthlyContribution: 5 * M,
        }),
      ],
      // 30tr aim + 10tr aim = 40tr wanted, 34tr there.
      new Map([['tcb', 34 * M]]),
    );
    const car = results.find((row) => row.goalId === 'goal-car');
    const trip = results.find((row) => row.goalId === 'goal-trip');
    expect(car?.closing).toBe(30 * M);
    expect(car?.actual).toBe(10 * M);
    // Whatever the high goal left behind.
    expect(trip?.closing).toBe(4 * M);
    expect(trip?.actual).toBe(-1 * M);
    expect(trip?.shortOnWallet).toBe(true);
  });

  it('splits a tie by the shares the household declared', () => {
    const results = settleMonthlyContributions(
      [
        share({
          allocationId: 'a-car',
          goalId: 'goal-car',
          allocatedAmount: 0,
          monthlyContribution: 10 * M,
          sharePercent: 70,
        }),
        share({
          allocationId: 'a-trip',
          goalId: 'goal-trip',
          allocatedAmount: 0,
          monthlyContribution: 10 * M,
          sharePercent: 30,
        }),
      ],
      // 20tr wanted, 10tr there.
      new Map([['tcb', 10 * M]]),
    );
    expect(results.find((row) => row.goalId === 'goal-car')?.closing).toBe(
      7 * M,
    );
    expect(results.find((row) => row.goalId === 'goal-trip')?.closing).toBe(
      3 * M,
    );
    expect(results.every((row) => row.needsShareDecision)).toBe(false);
  });

  // No shares declared: split by the aims, and flag it so the UI can ask rather
  // than present the product's fallback as the household's decision.
  it('flags a tie split without declared shares', () => {
    const results = settleMonthlyContributions(
      [
        share({
          allocationId: 'a-car',
          goalId: 'goal-car',
          allocatedAmount: 0,
          monthlyContribution: 10 * M,
        }),
        share({
          allocationId: 'a-trip',
          goalId: 'goal-trip',
          allocatedAmount: 0,
          monthlyContribution: 10 * M,
        }),
      ],
      new Map([['tcb', 10 * M]]),
    );
    expect(results.every((row) => row.closing === 5 * M)).toBe(true);
    expect(results.every((row) => row.needsShareDecision)).toBe(true);
  });

  // A goal asking for less than its weight must not strand money the rest of
  // the group could use.
  it('passes what a cap left over to the others in the group', () => {
    const results = settleMonthlyContributions(
      [
        share({
          allocationId: 'a-small',
          goalId: 'goal-small',
          allocatedAmount: 0,
          monthlyContribution: 2 * M,
          sharePercent: 50,
        }),
        share({
          allocationId: 'a-big',
          goalId: 'goal-big',
          allocatedAmount: 0,
          monthlyContribution: 20 * M,
          sharePercent: 50,
        }),
      ],
      // 22tr wanted, 12tr there. An even split would give the small goal 6tr —
      // 4tr more than it asks for — and strand it.
      new Map([['tcb', 12 * M]]),
    );
    expect(results.find((row) => row.goalId === 'goal-small')?.closing).toBe(
      2 * M,
    );
    expect(results.find((row) => row.goalId === 'goal-big')?.closing).toBe(
      10 * M,
    );
  });

  it('settles each wallet independently', () => {
    const results = settleMonthlyContributions(
      [
        share({ allocationId: 'a-tcb', assetId: 'tcb' }),
        share({
          allocationId: 'a-vcb',
          assetId: 'vcb',
          allocatedAmount: 0,
          monthlyContribution: 5 * M,
        }),
      ],
      new Map([
        ['tcb', 40 * M],
        ['vcb', 2 * M],
      ]),
    );
    expect(results.find((row) => row.assetId === 'tcb')?.actual).toBe(10 * M);
    expect(results.find((row) => row.assetId === 'vcb')?.actual).toBe(2 * M);
  });

  // A wallet that vanished (deleted, or never in the map) settles every share
  // against it to zero rather than throwing.
  it('settles a missing wallet to nothing', () => {
    const [result] = settleMonthlyContributions([share()], new Map());
    expect(result.closing).toBe(0);
    expect(result.actual).toBe(-20 * M);
  });
});
