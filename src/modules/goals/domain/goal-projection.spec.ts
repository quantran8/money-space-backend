import { projectGoal, projectGoalAfterSpend } from './goal-projection';
import type { GoalProjectionInput } from './goal-projection';

const M = 1_000_000;

function goal(over: Partial<GoalProjectionInput> = {}): GoalProjectionInput {
  return {
    goalId: 'g1',
    targetAmount: 1000 * M,
    currentAmount: 600 * M,
    plannedMonthlyContribution: 10 * M,
    targetDate: null,
    status: 'active',
    asOfDate: '2026-08-13',
    ...over,
  };
}

describe('projectGoal — progress', () => {
  it('computes remaining and progress', () => {
    const p = projectGoal(goal());
    expect(p.remainingAmount).toBe(400 * M);
    expect(p.progressPercent).toBe(60);
  });

  it('clamps an over-funded goal rather than reporting negative remaining', () => {
    const p = projectGoal(goal({ currentAmount: 1200 * M }));
    expect(p.remainingAmount).toBe(0);
    expect(p.progressPercent).toBe(100);
    expect(p.reason).toBe('already_complete');
  });

  it('reports 0% for a goal with no target', () => {
    expect(projectGoal(goal({ targetAmount: 0 })).progressPercent).toBe(0);
  });
});

describe('projectGoal — the divide-by-zero guard (§20)', () => {
  /**
   * With no declared contribution there is no honest way to name a date.
   * Inventing a pace would fabricate a completion date the household never
   * committed to — so the spec says show progress only and ask for a
   * contribution. These three cases are the regression guard.
   */
  it.each([
    ['null', null],
    ['zero', 0],
    ['negative', -5 * M],
  ])('returns no projected date when the contribution is %s', (_label, value) => {
    const p = projectGoal(goal({ plannedMonthlyContribution: value }));

    expect(p.projectedCompletionDate).toBeNull();
    expect(p.estimatedMonthsToGoal).toBeNull();
    expect(p.reason).toBe('no_contribution');
    // Progress is still shown — the user isn't left with nothing.
    expect(p.progressPercent).toBe(60);
  });

  it('still reports a fully funded goal as complete with no contribution', () => {
    const p = projectGoal(
      goal({ currentAmount: 1000 * M, plannedMonthlyContribution: null }),
    );
    expect(p.reason).toBe('already_complete');
    expect(p.projectedCompletionDate).toBe('2026-08-13');
  });
});

describe('projectGoal — projected completion', () => {
  it('projects months and a date at the declared pace', () => {
    const p = projectGoal(
      goal({ currentAmount: 600 * M, plannedMonthlyContribution: 10 * M }),
    );

    expect(p.estimatedMonthsToGoal).toBe(40);
    expect(p.projectedCompletionDate).toBe('2029-12-13');
  });

  // A partial month is still a month you have to live through.
  it('ceils partial months rather than rounding', () => {
    const p = projectGoal(
      goal({
        targetAmount: 100 * M,
        currentAmount: 75 * M,
        plannedMonthlyContribution: 10 * M,
      }),
    );

    expect(p.estimatedMonthsToGoal).toBe(3);
  });

  it('clamps the projected date to month length', () => {
    const p = projectGoal(
      goal({
        asOfDate: '2026-01-31',
        targetAmount: 100 * M,
        currentAmount: 90 * M,
        plannedMonthlyContribution: 10 * M,
      }),
    );

    expect(p.projectedCompletionDate).toBe('2026-02-28');
  });
});

describe('projectGoal — required contribution for a target date (04 §8)', () => {
  it('computes what it would take to hit the date', () => {
    const p = projectGoal(
      goal({
        targetAmount: 1000 * M,
        currentAmount: 880 * M,
        targetDate: '2027-08-13',
      }),
    );

    // 120M remaining over 12 months.
    expect(p.monthsUntilTargetDate).toBe(12);
    expect(p.requiredMonthlyContributionForTargetDate).toBe(10 * M);
  });

  // The number is useful precisely WHEN no pace is declared — it's the prompt.
  it('computes it even with no declared contribution', () => {
    const p = projectGoal(
      goal({
        targetAmount: 1000 * M,
        currentAmount: 880 * M,
        targetDate: '2027-08-13',
        plannedMonthlyContribution: null,
      }),
    );

    expect(p.requiredMonthlyContributionForTargetDate).toBe(10 * M);
    expect(p.reason).toBe('no_contribution');
  });

  it('asks for the whole remainder when the date has passed', () => {
    const p = projectGoal(
      goal({ currentAmount: 600 * M, targetDate: '2026-01-01' }),
    );

    expect(p.requiredMonthlyContributionForTargetDate).toBe(400 * M);
    expect(p.reason).toBe('target_date_passed');
  });

  it('returns null with no target date', () => {
    const p = projectGoal(goal({ targetDate: null }));
    expect(p.requiredMonthlyContributionForTargetDate).toBeNull();
    expect(p.reason).toBe('no_target_date');
  });

  it('reports whether the current pace makes the date', () => {
    const onPace = projectGoal(
      goal({
        currentAmount: 950 * M,
        plannedMonthlyContribution: 10 * M,
        targetDate: '2027-08-13',
      }),
    );
    const behind = projectGoal(
      goal({
        currentAmount: 600 * M,
        plannedMonthlyContribution: 10 * M,
        targetDate: '2027-08-13',
      }),
    );

    expect(onPace.onPaceForTargetDate).toBe(true);
    expect(behind.onPaceForTargetDate).toBe(false);
    expect(behind.paceGapMonths).toBe(28);
  });
});

describe('projectGoal — inactive goals', () => {
  it.each([['paused'], ['completed'], ['cancelled']] as const)(
    'does not project a %s goal',
    (status) => {
      const p = projectGoal(goal({ status }));
      expect(p.reason).toBe('goal_inactive');
      expect(p.projectedCompletionDate).toBeNull();
    },
  );
});

describe('projectGoalAfterSpend (05 §5)', () => {
  it('re-derives the date when the money comes out of the goal', () => {
    const input = goal({
      currentAmount: 600 * M,
      plannedMonthlyContribution: 10 * M,
    });

    const { projection, goalDelayMonths } = projectGoalAfterSpend(
      input,
      30 * M,
      { takenFromGoal: true },
    );

    expect(projection.currentAmount).toBe(570 * M);
    expect(projection.estimatedMonthsToGoal).toBe(43);
    expect(goalDelayMonths).toBe(3);
  });

  it('approximates the delay as spend / contribution otherwise', () => {
    const input = goal({ plannedMonthlyContribution: 10 * M });

    const { goalDelayMonths, goalDelayDays } = projectGoalAfterSpend(
      input,
      30 * M,
      { takenFromGoal: false },
    );

    expect(goalDelayMonths).toBe(3);
    expect(goalDelayDays).toBe(90);
  });

  it('cannot express a delay in time with no declared pace', () => {
    const { goalDelayMonths, goalDelayDays } = projectGoalAfterSpend(
      goal({ plannedMonthlyContribution: null }),
      30 * M,
      { takenFromGoal: false },
    );

    expect(goalDelayMonths).toBeNull();
    expect(goalDelayDays).toBeNull();
  });

  it('floors the goal at zero rather than going negative', () => {
    const { projection } = projectGoalAfterSpend(
      goal({ currentAmount: 10 * M }),
      50 * M,
      { takenFromGoal: true },
    );

    expect(projection.currentAmount).toBe(0);
  });
});
