import { resolveSpendImpact } from './spend-impact';
import type { GoalWalletClaim } from './goal-progress';

const M = 1_000_000;

/** The worked example: TCB holds 22tr, 20tr set aside, 20tr/month pace. */
const car: GoalWalletClaim = {
  goalId: 'car',
  priority: 'high',
  allocations: [
    {
      assetId: 'tcb',
      kind: 'fixed',
      role: 'contribution',
      allocatedAmount: 20 * M,
      monthlyContribution: 20 * M,
    },
  ],
};

describe('resolveSpendImpact', () => {
  it('reports no impact when nothing is being spent', () => {
    const result = resolveSpendImpact([car], 'tcb', 22 * M, 0);
    expect(result.totalReduction).toBe(0);
    expect(result.goals).toEqual([]);
  });

  it('takes this month’s contribution first', () => {
    const result = resolveSpendImpact([car], 'tcb', 22 * M, 2 * M);
    expect(result.totalReduction).toBe(2 * M);
    expect(result.goals).toEqual([
      {
        goalId: 'car',
        before: 22 * M,
        after: 20 * M,
        reduction: 2 * M,
        // The whole 2tr comes out of the pace; nothing set aside is touched.
        paceReduction: 2 * M,
        setAsideReduction: 0,
      },
    ]);
    expect(result.totalPaceReduction).toBe(2 * M);
    expect(result.totalSetAsideReduction).toBe(0);
  });

  it('eats into what is set aside once the contribution is gone', () => {
    const result = resolveSpendImpact([car], 'tcb', 22 * M, 5 * M);
    expect(result.goals[0]).toEqual({
      goalId: 'car',
      before: 22 * M,
      after: 17 * M,
      reduction: 5 * M,
      // 2tr of pace, then 3tr out of the 20tr set aside.
      paceReduction: 2 * M,
      setAsideReduction: 3 * M,
    });
    expect(result.totalPaceReduction).toBe(2 * M);
    expect(result.totalSetAsideReduction).toBe(3 * M);
  });

  /**
   * The distinction the household actually reads: a spend small enough to fit
   * inside this month's contribution pauses a month of saving, and must not be
   * reported as the goal moving backwards.
   */
  it('reports a small spend as pace-only', () => {
    const result = resolveSpendImpact([car], 'tcb', 22 * M, 1 * M);
    expect(result.totalPaceReduction).toBe(1 * M);
    expect(result.totalSetAsideReduction).toBe(0);
  });

  it('splits the two halves so they always sum to the total', () => {
    for (const spend of [1 * M, 2 * M, 3 * M, 5 * M, 25 * M]) {
      const result = resolveSpendImpact([car], 'tcb', 22 * M, spend);
      expect(result.totalPaceReduction + result.totalSetAsideReduction).toBe(
        result.totalReduction,
      );
    }
  });

  it('never reports a goal losing more than it held', () => {
    const result = resolveSpendImpact([car], 'tcb', 22 * M, 40 * M);
    expect(result.goals[0].after).toBe(0);
    expect(result.goals[0].reduction).toBe(22 * M);
    expect(result.assetValueAfter).toBe(0);
  });

  it('flags a spend the wallet cannot cover', () => {
    expect(resolveSpendImpact([car], 'tcb', 22 * M, 40 * M).exceedsWallet).toBe(
      true,
    );
    expect(resolveSpendImpact([car], 'tcb', 22 * M, 22 * M).exceedsWallet).toBe(
      false,
    );
  });

  it('leaves goals on other wallets untouched', () => {
    const house: GoalWalletClaim = {
      goalId: 'house',
      priority: 'high',
      allocations: [
        {
          assetId: 'vcb',
          kind: 'fixed',
          role: 'contribution',
          allocatedAmount: 10 * M,
        },
      ],
    };
    const result = resolveSpendImpact([car, house], 'tcb', 22 * M, 5 * M);
    expect(result.goals.map((goal) => goal.goalId)).toEqual(['car']);
  });

  /**
   * The regression: goals were resolved ONE AT A TIME, so each saw the whole
   * wallet as its own free room and the per-goal figures summed to more than
   * the wallet holds — two goals on a 20tr wallet reported 15tr and 13tr.
   */
  it('never reports the goals holding more than the wallet does', () => {
    const claims = [
      {
        goalId: 'g1',
        priority: 'high' as const,
        allocations: [
          {
            assetId: 'w',
            kind: 'fixed' as const,
            role: 'contribution' as const,
            allocatedAmount: 5 * M,
            monthlyContribution: 10 * M,
            sharePercent: 70,
          },
        ],
      },
      {
        goalId: 'g2',
        priority: 'high' as const,
        allocations: [
          {
            assetId: 'w',
            kind: 'fixed' as const,
            role: 'contribution' as const,
            allocatedAmount: 3 * M,
            monthlyContribution: 10 * M,
            sharePercent: 30,
          },
        ],
      },
    ];

    const result = resolveSpendImpact(claims, 'w', 20 * M, 0);
    // Nothing is being spent, so `goals` is empty — resolve at the same value
    // through a 1đ spend to read the standing figures instead.
    const standing = resolveSpendImpact(claims, 'w', 20 * M, 1);
    const totalBefore = standing.goals.reduce(
      (sum, goal) => sum + goal.before,
      0,
    );

    expect(result.totalReduction).toBe(0);
    expect(totalBefore).toBeLessThanOrEqual(20 * M);
  });

  it('splits a shortfall between same-priority goals by their shares', () => {
    const claims = [
      {
        goalId: 'g1',
        priority: 'high' as const,
        allocations: [
          {
            assetId: 'w',
            kind: 'fixed' as const,
            role: 'contribution' as const,
            allocatedAmount: 5 * M,
            monthlyContribution: 10 * M,
            sharePercent: 70,
          },
        ],
      },
      {
        goalId: 'g2',
        priority: 'high' as const,
        allocations: [
          {
            assetId: 'w',
            kind: 'fixed' as const,
            role: 'contribution' as const,
            allocatedAmount: 3 * M,
            monthlyContribution: 10 * M,
            sharePercent: 30,
          },
        ],
      },
    ];

    // 20tr wallet, 8tr set aside → 12tr free, split 70/30 → 8.4tr / 3.6tr.
    const result = resolveSpendImpact(claims, 'w', 20 * M, 1);
    const byGoal = new Map(result.goals.map((goal) => [goal.goalId, goal]));

    expect(byGoal.get('g1')?.before).toBeCloseTo(13.4 * M, 0);
    expect(byGoal.get('g2')?.before).toBeCloseTo(6.6 * M, 0);
  });

  /**
   * The reported bug: a 52tr wallet with 6tr unassigned, two goals each holding
   * 25% of it, and a 5tr spend reported "mục tiêu giảm 2,5tr". The spend fits
   * inside the unassigned money twice over — no goal should give up anything.
   *
   * Cause: re-reading "25% of the wallet" against the LOWERED value shaved both
   * claims proportionally. A percent claim describes a standing arrangement, not
   * a figure that re-derives itself every time a bill is scheduled.
   */
  it('leaves percent claims alone while the wallet has unassigned money', () => {
    const percentGoal = (goalId: string): GoalWalletClaim => ({
      goalId,
      priority: 'high',
      allocations: [
        {
          assetId: 'tcb',
          kind: 'percent',
          role: 'contribution',
          percent: 25,
        },
      ],
    });
    const claims = [percentGoal('car'), percentGoal('nha')];

    // 52tr wallet, 25% + 25% = 26tr claimed, 26tr unassigned.
    const result = resolveSpendImpact(claims, 'tcb', 52 * M, 5 * M);

    expect(result.totalReduction).toBe(0);
    expect(result.goals).toEqual([]);
  });

  it('still shrinks a percent claim once the wallet cannot hold it', () => {
    const claims: GoalWalletClaim[] = [
      {
        goalId: 'car',
        priority: 'high',
        allocations: [
          {
            assetId: 'tcb',
            kind: 'percent',
            role: 'contribution',
            percent: 100,
          },
        ],
      },
    ];

    // The whole wallet is claimed, so there is no unassigned money to absorb
    // the spend — the claim has to give way.
    const result = resolveSpendImpact(claims, 'tcb', 52 * M, 5 * M);

    expect(result.totalReduction).toBe(5 * M);
    expect(result.goals[0].after).toBe(47 * M);
  });

  it('lists the goal paying most for the spend first', () => {
    const small: GoalWalletClaim = {
      goalId: 'small',
      priority: 'low',
      allocations: [
        {
          assetId: 'tcb',
          kind: 'fixed',
          role: 'holding',
          allocatedAmount: 1 * M,
        },
      ],
    };
    const result = resolveSpendImpact([small, car], 'tcb', 22 * M, 40 * M);
    expect(result.goals.map((goal) => goal.goalId)).toEqual(['car', 'small']);
  });
});
