import { MoneyEventsService } from './money-events.service';

/**
 * `financial_goals.current_amount` is a REAL stored column and the source of
 * truth for goal progress (spec §20). An earlier stored column had to be
 * dropped because it DRIFTED — nothing incremented it on contribution and
 * nothing reversed it on delete.
 *
 * These tests pin the mirror that makes the column trustworthy: every
 * `goal_contribution` write must move the goal by exactly the right delta, and
 * nothing else may move it at all. If one of these fails, the column is lying.
 */
describe('MoneyEventsService — goal contribution mirror', () => {
  /**
   * Reaches the private effect method directly. That is deliberate: exercising
   * it through `createMoneyEvent` would drag in wallet effects, valuation
   * writes and the transaction runner, none of which this behaviour depends on.
   */
  function applyGoalContributionEffects(
    service: MoneyEventsService,
    householdId: string,
    event: Record<string, unknown>,
    sign: 1 | -1,
  ): Promise<void> {
    return (
      service as unknown as {
        applyGoalContributionEffects(
          householdId: string,
          event: Record<string, unknown>,
          sign: 1 | -1,
        ): Promise<void>;
      }
    ).applyGoalContributionEffects(householdId, event, sign);
  }

  function setup() {
    const adjustGoalCurrentAmount = jest.fn(async () => undefined);
    const repository = { adjustGoalCurrentAmount } as never;
    const service = new MoneyEventsService(
      repository,
      {} as never,
      {} as never,
      {},
    );
    return { service, adjustGoalCurrentAmount };
  }

  const contribution = {
    type: 'goal_contribution',
    financialGoalId: 'goal-house',
    amount: 5_000_000,
  };

  it('adds the full amount when a contribution is created', async () => {
    const { service, adjustGoalCurrentAmount } = setup();

    await applyGoalContributionEffects(service, 'hh-1', contribution, 1);

    expect(adjustGoalCurrentAmount).toHaveBeenCalledTimes(1);
    expect(adjustGoalCurrentAmount).toHaveBeenCalledWith(
      'hh-1',
      'goal-house',
      5_000_000,
    );
  });

  it('subtracts the full amount when a contribution is deleted', async () => {
    const { service, adjustGoalCurrentAmount } = setup();

    await applyGoalContributionEffects(service, 'hh-1', contribution, -1);

    expect(adjustGoalCurrentAmount).toHaveBeenCalledWith(
      'hh-1',
      'goal-house',
      -5_000_000,
    );
  });

  // An edit is reverse-then-apply. The two calls must net out to exactly the
  // difference, or repeated edits would inflate the goal.
  it('nets out to the difference when a contribution is edited', async () => {
    const { service, adjustGoalCurrentAmount } = setup();

    await applyGoalContributionEffects(service, 'hh-1', contribution, -1);
    await applyGoalContributionEffects(
      service,
      'hh-1',
      { ...contribution, amount: 8_000_000 },
      1,
    );

    const net = adjustGoalCurrentAmount.mock.calls.reduce(
      (sum, call) => sum + (call as unknown as [string, string, number])[2],
      0,
    );
    expect(net).toBe(3_000_000);
  });

  // Re-linking to a different goal must move the money, not duplicate it.
  it('moves progress between goals when the link changes', async () => {
    const { service, adjustGoalCurrentAmount } = setup();

    await applyGoalContributionEffects(service, 'hh-1', contribution, -1);
    await applyGoalContributionEffects(
      service,
      'hh-1',
      { ...contribution, financialGoalId: 'goal-car' },
      1,
    );

    expect(adjustGoalCurrentAmount).toHaveBeenNthCalledWith(
      1,
      'hh-1',
      'goal-house',
      -5_000_000,
    );
    expect(adjustGoalCurrentAmount).toHaveBeenNthCalledWith(
      2,
      'hh-1',
      'goal-car',
      5_000_000,
    );
  });

  it.each([
    ['expense', { ...contribution, type: 'expense' }],
    ['income', { ...contribution, type: 'income' }],
    ['transfer', { ...contribution, type: 'transfer' }],
    ['asset_update', { ...contribution, type: 'asset_update' }],
  ])('never touches a goal for a %s event', async (_label, event) => {
    const { service, adjustGoalCurrentAmount } = setup();

    await applyGoalContributionEffects(service, 'hh-1', event, 1);

    expect(adjustGoalCurrentAmount).not.toHaveBeenCalled();
  });

  // A contribution with no goal attached has nothing to move; writing anyway
  // would throw on a null id inside the transaction and roll back the event.
  it('is a no-op when the contribution has no goal linked', async () => {
    const { service, adjustGoalCurrentAmount } = setup();

    await applyGoalContributionEffects(
      service,
      'hh-1',
      { ...contribution, financialGoalId: null },
      1,
    );

    expect(adjustGoalCurrentAmount).not.toHaveBeenCalled();
  });
});
