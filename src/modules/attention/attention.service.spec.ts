import { AttentionService } from './attention.service';
import type { ForecastInput } from '../forecast/domain/forecast.types';

const M = 1_000_000;

function forecastInput(over: Partial<ForecastInput> = {}): ForecastInput {
  return {
    householdId: 'hh-1',
    asOfDate: '2026-08-13',
    horizonDays: 30,
    assets: [
      {
        assetId: 'a1',
        name: 'VCB',
        value: 5 * M,
        liquidity: 'usable_now',
        type: 'bank_account',
        valueUpdatedAt: '2026-08-13',
      },
    ],
    cashflowEvents: [
      {
        id: 'e1',
        name: 'Rent',
        direction: 'outgoing',
        amount: 20 * M,
        expectedDate: '2026-08-20',
        recurrence: 'once',
        recurrenceEndDate: null,
        requirement: 'required',
        certainty: 'confirmed',
        status: 'expected',
      },
    ],
    ...over,
  };
}

function setup(
  options: {
    input?: Partial<ForecastInput>;
    updateFrequency?: 'weekly' | 'monthly' | 'manual';
    goals?: Array<{ id: string; name: string }>;
    allocations?: Array<{ financialGoalId: string; role: string }>;
  } = {},
) {
  const attentionRepository = {
    assertHousehold: jest.fn(() =>
      Promise.resolve({
        id: 'hh-1',
        updateFrequency: options.updateFrequency ?? 'weekly',
      }),
    ),
  } as never;

  const forecast = {
    loadInput: jest.fn(async () => forecastInput(options.input)),
  } as never;

  // Feeds `goal_without_wallet`. Empty by default: these cases are about the
  // forecast-derived signals, and a household with no goals raises none of it.
  const goalsRepository = {
    findFinancialGoalsByHousehold: jest.fn(async () => options.goals ?? []),
    findAllocationsByHousehold: jest.fn(async () => options.allocations ?? []),
  } as never;

  return {
    service: new AttentionService(
      attentionRepository,
      forecast,
      goalsRepository,
    ),
    attentionRepository: attentionRepository as Record<string, jest.Mock>,
  };
}

describe('AttentionService.listAttentionItems', () => {
  /**
   * Every signal is derived, so a read is a pure computation over the forecast
   * bundle. The `attention_items` table and its stored/dismiss lifecycle were
   * dropped (2026-08-29) — nothing to read, nothing to write.
   */
  it('returns only derived signals', async () => {
    const { service } = setup();
    const result = await service.listAttentionItems('hh-1');

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.total).toBe(result.items.length);
  });

  it('raises a signal for a wallet holding a negative balance', async () => {
    const { service } = setup({
      input: {
        assets: [
          {
            assetId: 'a1',
            name: 'TCB',
            value: -4 * M,
            liquidity: 'usable_now',
            type: 'bank_account',
            valueUpdatedAt: '2026-08-13',
          },
        ],
      },
    });

    const result = await service.listAttentionItems('hh-1');
    const signal = result.items.find(
      (item) => item.ruleCode === 'wallet_overdrawn',
    );
    expect(signal?.relatedObjectId).toBe('a1');
    expect(signal?.amount).toBe(-4 * M);
  });

  /**
   * The client owns all copy (hard i18n mandate) and §29 governs the tone.
   * A backend-rendered sentence can be neither translated nor softened.
   */
  it('emits no prose on derived signals — only codes and params', async () => {
    const { service } = setup();
    const result = await service.listAttentionItems('hh-1');

    for (const item of result.items) {
      expect(item.ruleCode).toEqual(expect.any(String));
      expect(item).not.toHaveProperty('title');
      expect(item).not.toHaveProperty('reason');
    }
  });

  it('surfaces the most urgent signal first', async () => {
    const { service } = setup();
    const result = await service.listAttentionItems('hh-1');

    const rank = { urgent: 0, important: 1, normal: 2 };
    const ranks = result.items.map((i) => rank[i.level]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  /**
   * The repository now exposes nothing but `assertHousehold`, so there is no
   * write to make by accident — this pins that surface rather than the absence
   * of calls that no longer exist.
   */
  it('touches the database only to check the household exists', async () => {
    const { service, attentionRepository } = setup();
    await service.listAttentionItems('hh-1');

    expect(Object.keys(attentionRepository)).toEqual(['assertHousehold']);
    expect(attentionRepository.assertHousehold).toHaveBeenCalledWith('hh-1');
  });

  /**
   * A household on `manual` said "we'll update when we want to". Grading them
   * against a cadence they never agreed to is the nagging §29 forbids.
   */
  // The signal reads `role`, not the asset's type: `role` is the household's own
  // answer to "is this wallet feeding the goal, or value it already holds?", and
  // it is the same field the asset delete flow checks when it warns a goal is
  // about to lose its last wallet. Two places answering "does this goal have a
  // wallet?" differently is how the warning and the signal would disagree.
  it('flags a goal whose claims are all holdings', async () => {
    const { service } = setup({
      goals: [{ id: 'goal-car', name: 'Mua xe' }],
      allocations: [{ financialGoalId: 'goal-car', role: 'holding' }],
    });

    const result = await service.listAttentionItems('hh-1');
    const signal = result.items.find(
      (item) => item.ruleCode === 'goal_without_wallet',
    );
    expect(signal).toBeDefined();
    expect(signal?.relatedObjectId).toBe('goal-car');
  });

  it('does not flag a goal that still has a contribution wallet', async () => {
    const { service } = setup({
      goals: [{ id: 'goal-car', name: 'Mua xe' }],
      allocations: [
        { financialGoalId: 'goal-car', role: 'holding' },
        { financialGoalId: 'goal-car', role: 'contribution' },
      ],
    });

    const result = await service.listAttentionItems('hh-1');
    expect(
      result.items.some((item) => item.ruleCode === 'goal_without_wallet'),
    ).toBe(false);
  });

  // A goal with NOTHING behind it is a different situation — nothing has been
  // chosen yet, rather than the wallet having gone away — and is not this
  // signal's job.
  it('does not flag a goal with no claims at all', async () => {
    const { service } = setup({
      goals: [{ id: 'goal-new', name: 'Chưa chọn tài sản' }],
      allocations: [],
    });

    const result = await service.listAttentionItems('hh-1');
    expect(
      result.items.some((item) => item.ruleCode === 'goal_without_wallet'),
    ).toBe(false);
  });

  it('raises no staleness signal for a household on manual cadence', async () => {
    const { service } = setup({
      updateFrequency: 'manual',
      input: {
        assets: [
          {
            assetId: 'a1',
            name: 'VCB',
            value: 5 * M,
            liquidity: 'usable_now',
            type: 'bank_account',
            valueUpdatedAt: '2020-01-01',
          },
        ],
      },
    });

    const result = await service.listAttentionItems('hh-1');
    expect(result.items.map((i) => i.ruleCode)).not.toContain('stale_data');
  });
});
