import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GoalsService } from './goals.service';
import type {
  FinancialGoal,
  GoalAssetAllocation,
} from './entities/financial-goal.entity';

const M = 1_000_000;

/**
 * The rules that keep a goal's progress tied to real money.
 *
 * The two that matter most: a goal cannot exist without assets behind it (there
 * would be nothing to derive progress from), and the same money can never be
 * promised to two goals at once.
 */
function goal(over: Partial<FinancialGoal> = {}): FinancialGoal {
  return {
    id: 'goal-car',
    householdId: 'hh-1',
    name: 'Mua xe',
    targetAmount: 500 * M,
    plannedMonthlyContribution: null,
    baselineContributionAmount: null,
    priority: 'medium',
    note: '',
    targetDate: 'No deadline',
    ...over,
  };
}

function allocation(
  over: Partial<GoalAssetAllocation> = {},
): GoalAssetAllocation {
  return {
    id: 'alloc-1',
    householdId: 'hh-1',
    financialGoalId: 'goal-car',
    assetId: 'stocks',
    kind: 'fixed',
    role: 'holding',
    monthlyContribution: null,
    sharePercent: null,
    allocatedAmount: 50 * M,
    percent: null,
    note: '',
    ...over,
  };
}

const WALLET = { id: 'vcb', type: 'bank_account', currentValue: 200 * M };
const STOCKS = { id: 'stocks', type: 'stock', currentValue: 100 * M };

function setup(
  options: {
    goal?: FinancialGoal;
    /** Every goal in the household, when a case needs more than one. */
    goals?: FinancialGoal[];
    allocations?: GoalAssetAllocation[];
    assets?: Array<{ id: string; type: string; currentValue: number }>;
  } = {},
) {
  const allocations = options.allocations ?? [];
  const insertAllocation = jest.fn(async () => undefined);
  const updateAllocation = jest.fn(async () => undefined);
  const deleteAllocationsByGoal = jest.fn(async () => undefined);
  const insertFinancialGoal = jest.fn(async () => undefined);
  const updatePlannedMonthlyContribution = jest.fn(async () => undefined);
  const repository = {
    assertHousehold: jest.fn(async () => ({}) as never),
    createId: () => 'alloc-new',
    findFinancialGoalById: jest.fn(async () => options.goal ?? goal()),
    findAllocationsByHousehold: jest.fn(async () => allocations),
    // The share check needs each goal's priority, which lives on the goal.
    findFinancialGoalsByHousehold: jest.fn(
      async () => options.goals ?? (options.goal ? [options.goal] : [goal()]),
    ),
    findAllocationsByGoal: jest.fn(async () => allocations),
    findAllocationById: jest.fn(
      async (_hh: string, id: string) =>
        allocations.find((row) => row.id === id) ?? undefined,
    ),
    insertAllocation,
    updateAllocation,
    deleteAllocation: jest.fn(async () => undefined),
    deleteAllocationsByGoal,
    insertFinancialGoal,
    deleteFinancialGoal: jest.fn(async () => undefined),
    unlinkFinancialGoalFromMoneyEvents: jest.fn(async () => undefined),
    updatePlannedMonthlyContribution,
  } as never;
  const prisma = {
    runInTransaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
  } as never;
  const assetsService = {
    getActiveAssetRecords: jest.fn(
      async () => options.assets ?? [STOCKS, WALLET],
    ),
  } as never;

  const snapshotsRepository = {
    // Monthly progress reads frozen snapshot points; these tests are about the
    // allocation rules, so an empty history is the right neutral fixture.
    findGoalProgressPoints: jest.fn(async () => []),
  } as never;

  const service = new GoalsService(
    repository,
    prisma,
    assetsService,
    snapshotsRepository,
  );
  return {
    service,
    insertAllocation,
    updateAllocation,
    deleteAllocationsByGoal,
    insertFinancialGoal,
    updatePlannedMonthlyContribution,
  };
}

describe('GoalsService — creating a goal', () => {
  const withAssets = {
    name: 'Mua xe',
    targetAmount: 500 * M,
    priority: 'medium' as const,
  };

  it('refuses a goal with no assets behind it', async () => {
    // A goal with no allocations has no progress and no way to gain any — it
    // would sit at 0% forever with nothing for the household to do about it.
    const { service } = setup();
    await expect(
      service.createFinancialGoal('hh-1', { ...withAssets, allocations: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates the goal and its allocations together', async () => {
    const { service, insertAllocation } = setup();
    const card = await service.createFinancialGoal('hh-1', {
      ...withAssets,
      allocations: [
        { assetId: 'stocks', kind: 'fixed', allocatedAmount: 50 * M },
        { assetId: 'vcb', kind: 'fixed', allocatedAmount: 100 * M },
      ],
    });
    expect(insertAllocation).toHaveBeenCalledTimes(2);
    // Progress is real from the moment the goal exists.
    expect(card.currentAmount).toBe(150 * M);
  });

  // Money is only ever put into a goal through a wallet, so backed by stocks
  // alone the figure moves on the market and the pace panel has no source to
  // read. This USED to be refused. It is allowed now, because the state is
  // reachable without anyone choosing it — deleting an asset can take a goal's
  // last wallet — and a create-time-only rule left such goals unable to be
  // edited back into legality. The household is told instead: the
  // `goal_without_wallet` attention signal fires for exactly this shape.
  it('allows a goal backed only by holdings, with no pace', async () => {
    const { service, insertFinancialGoal } = setup();
    const card = await service.createFinancialGoal('hh-1', {
      ...withAssets,
      allocations: [
        { assetId: 'stocks', kind: 'fixed', allocatedAmount: 50 * M },
      ],
    });
    expect(insertFinancialGoal).toHaveBeenCalled();
    // Progress still counts — the stocks really are behind the goal.
    expect(card.currentAmount).toBe(50 * M);
    // But there is no pace: null means "no target", not "planned to save zero".
    // Create writes the pace onto the goal row itself, so it is read from the
    // inserted goal rather than from the mirror-update call.
    expect(insertFinancialGoal).toHaveBeenCalledWith(
      expect.objectContaining({ plannedMonthlyContribution: null }),
    );
  });

  // The one thing still refused: a goal with NOTHING behind it has no progress
  // and no way to gain any, so it would sit at a permanent 0%.
  it('still refuses a goal with no allocations at all', async () => {
    const { service, insertFinancialGoal } = setup();
    await expect(
      service.createFinancialGoal('hh-1', { ...withAssets, allocations: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(insertFinancialGoal).not.toHaveBeenCalled();
  });

  // "10tr a month" is really "6tr out of the salary account and 4tr in cash".
  it('stores the goal pace as the sum of its wallets', async () => {
    const { service, insertFinancialGoal } = setup({
      assets: [WALLET, { id: 'cash-box', type: 'cash', currentValue: 50 * M }],
    });
    const card = await service.createFinancialGoal('hh-1', {
      ...withAssets,
      allocations: [
        {
          assetId: 'vcb',
          kind: 'fixed',
          allocatedAmount: 100 * M,
          monthlyContribution: 6 * M,
        },
        {
          assetId: 'cash-box',
          kind: 'fixed',
          allocatedAmount: 20 * M,
          monthlyContribution: 4 * M,
        },
      ],
    });
    expect(card.plannedMonthlyContribution).toBe(10 * M);
    expect(insertFinancialGoal).toHaveBeenCalledWith(
      expect.objectContaining({ plannedMonthlyContribution: 10 * M }),
    );
  });

  // No wallet declared an amount: no pace was planned. Null, not 0 — 0 is a
  // promise to save nothing, and every month would be reported as kept.
  it('leaves the pace null when no wallet declares one', async () => {
    const { service } = setup();
    const card = await service.createFinancialGoal('hh-1', {
      ...withAssets,
      allocations: [
        { assetId: 'vcb', kind: 'fixed', allocatedAmount: 100 * M },
      ],
    });
    expect(card.plannedMonthlyContribution).toBeNull();
  });

  // A pace has to name the account the money comes out of. Rejected rather than
  // dropped: a household that typed 5tr against their gold misunderstood
  // something, and storing nothing would let them keep believing it.
  it('rejects a monthly amount declared against gold', async () => {
    const { service } = setup({
      assets: [WALLET, { id: 'gold', type: 'gold', currentValue: 100 * M }],
    });
    await expect(
      service.createFinancialGoal('hh-1', {
        ...withAssets,
        allocations: [
          { assetId: 'vcb', kind: 'fixed', allocatedAmount: 10 * M },
          {
            assetId: 'gold',
            kind: 'fixed',
            allocatedAmount: 50 * M,
            monthlyContribution: 5 * M,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // "Set aside 100tr from shared money" is a fixed share of the wallet holding
  // it — shared money is not a separate kind of money.
  it('treats a wallet share as an ordinary allocation', async () => {
    const { service } = setup({ assets: [WALLET] });
    const card = await service.createFinancialGoal('hh-1', {
      ...withAssets,
      allocations: [
        { assetId: 'vcb', kind: 'fixed', allocatedAmount: 100 * M },
      ],
    });
    expect(card.currentAmount).toBe(100 * M);
  });

  it('rejects the whole goal when one allocation exceeds its asset', async () => {
    const { service, insertFinancialGoal } = setup();
    await expect(
      service.createFinancialGoal('hh-1', {
        ...withAssets,
        allocations: [
          { assetId: 'stocks', kind: 'fixed', allocatedAmount: 500 * M },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Nothing written: a goal that lands with half its assets is worse than one
    // that does not land at all.
    expect(insertFinancialGoal).not.toHaveBeenCalled();
  });

  it('counts two claims in the same payload against each other', async () => {
    // Each fits alone (60tr of a 100tr asset), together they do not.
    const { service } = setup();
    await expect(
      service.createFinancialGoal('hh-1', {
        ...withAssets,
        allocations: [
          { assetId: 'stocks', kind: 'fixed', allocatedAmount: 60 * M },
          { assetId: 'stocks', kind: 'fixed', allocatedAmount: 60 * M },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown asset', async () => {
    const { service } = setup();
    await expect(
      service.createFinancialGoal('hh-1', {
        ...withAssets,
        allocations: [
          { assetId: 'not-mine', kind: 'fixed', allocatedAmount: 1 * M },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * A wallet's monthly room, divided between goals tied at one priority.
 *
 * Sibling to the over-allocation rule: that one stops a household promising more
 * MONEY than a wallet holds, this one stops them promising more of its monthly
 * ROOM than exists.
 */
describe('GoalsService — wallet shares', () => {
  const base = {
    name: 'Mua xe',
    targetAmount: 500 * M,
    priority: 'medium' as const,
  };

  it('refuses shares of one wallet that together pass 100%', async () => {
    // An existing `medium` goal already takes 70% of vcb.
    const { service } = setup({
      goal: goal({ id: 'goal-other', priority: 'medium' }),
      allocations: [
        allocation({
          id: 'alloc-other',
          financialGoalId: 'goal-other',
          assetId: 'vcb',
          role: 'contribution',
          allocatedAmount: 10 * M,
          monthlyContribution: 5 * M,
          sharePercent: 70,
        }),
      ],
    });
    await expect(
      service.createFinancialGoal('hh-1', {
        ...base,
        allocations: [
          {
            assetId: 'vcb',
            kind: 'fixed',
            role: 'contribution',
            allocatedAmount: 10 * M,
            monthlyContribution: 5 * M,
            sharePercent: 40,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a share that fits in what the priority group has left', async () => {
    const { service, insertAllocation } = setup({
      goal: goal({ id: 'goal-other', priority: 'medium' }),
      allocations: [
        allocation({
          id: 'alloc-other',
          financialGoalId: 'goal-other',
          assetId: 'vcb',
          role: 'contribution',
          allocatedAmount: 10 * M,
          monthlyContribution: 5 * M,
          sharePercent: 70,
        }),
      ],
    });
    await service.createFinancialGoal('hh-1', {
      ...base,
      allocations: [
        {
          assetId: 'vcb',
          kind: 'fixed',
          role: 'contribution',
          allocatedAmount: 10 * M,
          monthlyContribution: 5 * M,
          sharePercent: 30,
        },
      ],
    });
    expect(insertAllocation).toHaveBeenCalledWith(
      expect.objectContaining({ sharePercent: 30 }),
    );
  });

  // A goal at a DIFFERENT priority never divides anything with this one — it is
  // served first, or last. Adding their shares would refuse a pair that never
  // competed for the same money.
  it('ignores shares held by goals at another priority', async () => {
    const { service, insertAllocation } = setup({
      goal: goal({ id: 'goal-other', priority: 'high' }),
      allocations: [
        allocation({
          id: 'alloc-other',
          financialGoalId: 'goal-other',
          assetId: 'vcb',
          role: 'contribution',
          allocatedAmount: 10 * M,
          monthlyContribution: 5 * M,
          sharePercent: 90,
        }),
      ],
    });
    await service.createFinancialGoal('hh-1', {
      ...base,
      allocations: [
        {
          assetId: 'vcb',
          kind: 'fixed',
          role: 'contribution',
          allocatedAmount: 10 * M,
          monthlyContribution: 5 * M,
          sharePercent: 90,
        },
      ],
    });
    expect(insertAllocation).toHaveBeenCalledWith(
      expect.objectContaining({ sharePercent: 90 }),
    );
  });

  // Gold is not fed monthly, so there is no room on it to divide.
  it('rejects a share declared against a holding', async () => {
    const { service } = setup();
    await expect(
      service.createFinancialGoal('hh-1', {
        ...base,
        allocations: [
          { assetId: 'vcb', kind: 'fixed', allocatedAmount: 10 * M },
          {
            assetId: 'stocks',
            kind: 'fixed',
            allocatedAmount: 10 * M,
            sharePercent: 50,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a share outside 1–100', async () => {
    const { service } = setup();
    await expect(
      service.createFinancialGoal('hh-1', {
        ...base,
        allocations: [
          {
            assetId: 'vcb',
            kind: 'fixed',
            role: 'contribution',
            allocatedAmount: 10 * M,
            monthlyContribution: 5 * M,
            sharePercent: 140,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('GoalsService — allocations', () => {
  it('accepts a fixed share that fits inside the asset', async () => {
    const { service, insertAllocation } = setup();
    const card = await service.createAllocation('hh-1', 'goal-car', {
      assetId: 'stocks',
      kind: 'fixed',
      allocatedAmount: 50 * M,
    });
    expect(insertAllocation).toHaveBeenCalledTimes(1);
    expect(card.currentValue).toBe(50 * M);
  });

  // The case that shaped the model: 100tr of stocks, 50tr to the car, the rest
  // still free — but not another 60tr on top of that.
  it('rejects a second claim that would exceed the asset value', async () => {
    const { service } = setup({
      allocations: [
        allocation({ financialGoalId: 'goal-house', allocatedAmount: 50 * M }),
      ],
    });
    await expect(
      service.createAllocation('hh-1', 'goal-car', {
        assetId: 'stocks',
        kind: 'fixed',
        allocatedAmount: 60 * M,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a second claim that fits in what is left', async () => {
    const { service, insertAllocation } = setup({
      allocations: [
        allocation({ financialGoalId: 'goal-house', allocatedAmount: 50 * M }),
      ],
    });
    await service.createAllocation('hh-1', 'goal-car', {
      assetId: 'stocks',
      kind: 'fixed',
      allocatedAmount: 50 * M,
    });
    expect(insertAllocation).toHaveBeenCalledTimes(1);
  });

  // A percent claim and a fixed one must be measured on the same scale, or
  // "all of it" plus "50tr of it" would quietly both be allowed.
  it('counts a percent claim against the asset value too', async () => {
    const { service } = setup({
      allocations: [
        allocation({
          financialGoalId: 'goal-house',
          kind: 'percent',
          allocatedAmount: null,
          percent: 100,
        }),
      ],
    });
    await expect(
      service.createAllocation('hh-1', 'goal-car', {
        assetId: 'stocks',
        kind: 'fixed',
        allocatedAmount: 10 * M,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a second allocation of the same asset to the same goal', async () => {
    const { service } = setup({ allocations: [allocation()] });
    await expect(
      service.createAllocation('hh-1', 'goal-car', {
        assetId: 'stocks',
        kind: 'fixed',
        allocatedAmount: 10 * M,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a percent outside 0–100', async () => {
    const { service } = setup();
    await expect(
      service.createAllocation('hh-1', 'goal-car', {
        assetId: 'stocks',
        kind: 'percent',
        percent: 120,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a fixed allocation with no amount', async () => {
    const { service } = setup();
    await expect(
      service.createAllocation('hh-1', 'goal-car', {
        assetId: 'stocks',
        kind: 'fixed',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an allocation against an asset the household does not have', async () => {
    const { service } = setup();
    await expect(
      service.createAllocation('hh-1', 'goal-car', {
        assetId: 'not-mine',
        kind: 'fixed',
        allocatedAmount: 1 * M,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // Editing in place must not count the row against itself.
  it('excludes the edited row from its own over-allocation check', async () => {
    const { service, updateAllocation } = setup({
      allocations: [allocation({ allocatedAmount: 100 * M })],
    });
    await service.updateAllocation('hh-1', 'goal-car', 'alloc-1', {
      allocatedAmount: 90 * M,
    });
    expect(updateAllocation).toHaveBeenCalledTimes(1);
  });
});

describe('GoalsService — the goal pace mirror', () => {
  // The stored column exists so every goal surface can show a pace without
  // reading allocations. That is only safe while the two are written together.
  it('rewrites the goal pace when a wallet share is added', async () => {
    const { service, updatePlannedMonthlyContribution } = setup();
    await service.createAllocation('hh-1', 'goal-car', {
      assetId: 'vcb',
      kind: 'fixed',
      allocatedAmount: 100 * M,
      monthlyContribution: 7 * M,
    });
    expect(updatePlannedMonthlyContribution).toHaveBeenCalledWith(
      'hh-1',
      'goal-car',
      7 * M,
    );
  });

  it('rewrites the goal pace when a wallet share changes', async () => {
    const { service, updatePlannedMonthlyContribution } = setup({
      allocations: [
        allocation({
          id: 'alloc-vcb',
          assetId: 'vcb',
          role: 'contribution',
          monthlyContribution: 7 * M,
          allocatedAmount: 100 * M,
        }),
      ],
    });
    await service.updateAllocation('hh-1', 'goal-car', 'alloc-vcb', {
      monthlyContribution: 3 * M,
    });
    expect(updatePlannedMonthlyContribution).toHaveBeenCalledWith(
      'hh-1',
      'goal-car',
      3 * M,
    );
  });

  // Editing something else about the share must not drop the figure — an
  // absent field is "leave it", only an explicit null clears it.
  it('keeps the declared amount when the payload does not mention it', async () => {
    const { service, updateAllocation } = setup({
      allocations: [
        allocation({
          id: 'alloc-vcb',
          assetId: 'vcb',
          role: 'contribution',
          monthlyContribution: 7 * M,
          allocatedAmount: 100 * M,
        }),
      ],
    });
    await service.updateAllocation('hh-1', 'goal-car', 'alloc-vcb', {
      note: 'luong thang',
    });
    expect(updateAllocation).toHaveBeenCalledWith(
      'alloc-vcb',
      expect.objectContaining({ monthlyContribution: 7 * M }),
    );
  });

  it('clears the goal pace when the last wallet amount is removed', async () => {
    const { service, updatePlannedMonthlyContribution } = setup({
      allocations: [
        allocation({
          id: 'alloc-vcb',
          assetId: 'vcb',
          role: 'contribution',
          monthlyContribution: 7 * M,
          allocatedAmount: 100 * M,
        }),
      ],
    });
    await service.updateAllocation('hh-1', 'goal-car', 'alloc-vcb', {
      monthlyContribution: null,
    });
    expect(updatePlannedMonthlyContribution).toHaveBeenCalledWith(
      'hh-1',
      'goal-car',
      null,
    );
  });

  // Removing the last wallet was refused, to mirror the create-time rule. Both
  // are gone for the same reason (see the create case above): deleting the
  // ASSET reached the same state with no guard at all, so refusing it here only
  // pushed the household onto the unguarded route. The goal survives without a
  // wallet, and its pace drops to null rather than keeping a figure no wallet
  // is funding any more.
  it("allows removing the goal's only wallet, clearing the pace", async () => {
    const { service, updatePlannedMonthlyContribution } = setup({
      allocations: [
        allocation({
          id: 'alloc-vcb',
          assetId: 'vcb',
          role: 'contribution',
          allocatedAmount: 100 * M,
        }),
        allocation({ id: 'alloc-stocks', assetId: 'stocks' }),
      ],
    });
    await expect(
      service.deleteAllocation('hh-1', 'goal-car', 'alloc-vcb'),
    ).resolves.toEqual({ deleted: true, allocationId: 'alloc-vcb' });
    expect(updatePlannedMonthlyContribution).toHaveBeenCalledWith(
      'hh-1',
      'goal-car',
      null,
    );
  });

  it('allows removing a holding, and a wallet that is not the last', async () => {
    const { service } = setup({
      allocations: [
        allocation({
          id: 'alloc-vcb',
          assetId: 'vcb',
          role: 'contribution',
          allocatedAmount: 100 * M,
        }),
        allocation({
          id: 'alloc-cash',
          assetId: 'cash-box',
          role: 'contribution',
          monthlyContribution: 4 * M,
          allocatedAmount: 10 * M,
        }),
      ],
      assets: [WALLET, { id: 'cash-box', type: 'cash', currentValue: 50 * M }],
    });
    const result = await service.deleteAllocation(
      'hh-1',
      'goal-car',
      'alloc-vcb',
    );
    expect(result.deleted).toBe(true);
  });
});

describe('GoalsService — reading a goal', () => {
  it('reports progress from its assets', async () => {
    const { service } = setup({
      allocations: [
        allocation({ kind: 'percent', allocatedAmount: null, percent: 50 }),
      ],
    });
    const card = await service.getFinancialGoal('hh-1', 'goal-car');
    expect(card.currentAmount).toBe(50 * M);
    expect(card.progress).toBe(10);
  });

  it('lowers progress when the asset is spent down', async () => {
    // No goal-side write happened — the expense debited the wallet, and the
    // capped claim reports the truth on the next read.
    const { service } = setup({
      allocations: [allocation({ allocatedAmount: 50 * M })],
      assets: [{ id: 'stocks', type: 'stock', currentValue: 30 * M }],
    });
    const card = await service.getFinancialGoal('hh-1', 'goal-car');
    expect(card.currentAmount).toBe(30 * M);
  });
});

/**
 * The asset's own view of the goals it backs.
 *
 * The mirror of a goal's allocation panel: opening an account used to show a
 * balance with no hint that most of it was already promised.
 */
describe('GoalsService — what an asset is backing', () => {
  it('lists every goal on the asset and what is still free', async () => {
    const { service } = setup({
      goal: goal({ id: 'goal-car', priority: 'high' }),
      allocations: [
        allocation({
          id: 'alloc-1',
          financialGoalId: 'goal-car',
          assetId: 'vcb',
          role: 'contribution',
          allocatedAmount: 60 * M,
          monthlyContribution: 5 * M,
        }),
      ],
      assets: [WALLET],
    });

    const usage = await service.assetGoalUsage('hh-1', 'vcb');

    expect(usage.assetValue).toBe(200 * M);
    expect(usage.claimedAmount).toBe(60 * M);
    expect(usage.freeAmount).toBe(140 * M);
    expect(usage.items).toHaveLength(1);
    expect(usage.items[0]).toMatchObject({
      goalName: 'Mua xe',
      priority: 'high',
      currentValue: 60 * M,
    });
  });

  /**
   * The reported contradiction: a wallet whose whole balance is spoken for still
   * read "32tr chưa dành cho mục tiêu nào", because `freeAmount` only subtracts
   * money SET ASIDE and ignores what the monthly paces will draw from the rest.
   *
   * `freeAmount` is right for the question it answers (how much may a NEW claim
   * take — a pace locks nothing away from that). It is the wrong figure for
   * "how much has no job yet", which is what the asset page and the spend
   * warning ask, so `unassignedAmount` answers that one instead.
   */
  it('counts the monthly paces as committed, not as unassigned', async () => {
    const car = goal({ id: 'goal-car', name: 'car', priority: 'high' });
    const house = goal({ id: 'goal-house', name: 'nha', priority: 'high' });
    const { service } = setup({
      goals: [car, house],
      goal: car,
      allocations: [
        allocation({
          id: 'alloc-car',
          financialGoalId: 'goal-car',
          assetId: 'vcb',
          role: 'contribution',
          allocatedAmount: 20 * M,
          monthlyContribution: 20 * M,
        }),
        allocation({
          id: 'alloc-house',
          financialGoalId: 'goal-house',
          assetId: 'vcb',
          role: 'contribution',
          allocatedAmount: 0,
          monthlyContribution: 20 * M,
        }),
      ],
      assets: [{ id: 'vcb', type: 'bank_account', currentValue: 52 * M }],
    });

    const usage = await service.assetGoalUsage('hh-1', 'vcb');

    // Set aside is 20tr, so a new claim could still take 32tr…
    expect(usage.freeAmount).toBe(32 * M);
    // …but both paces are already drawing on that 32tr, so nothing is
    // unassigned, and the whole wallet has a job.
    expect(usage.committedAmount).toBe(52 * M);
    expect(usage.unassignedAmount).toBe(0);
  });

  /**
   * A wallet may now hold a NEGATIVE balance: editing a back-dated event replays
   * the wallet from its opening balance, and an overdrawn result is recorded
   * rather than clamped (see the wallet-replay work). Every goal figure has to
   * survive that — a goal can never be committed a negative amount, which would
   * read as the goals owing the household money.
   */
  it('commits nothing when the wallet is overdrawn', async () => {
    const { service } = setup({
      goal: goal({ id: 'goal-car', name: 'car', priority: 'high' }),
      allocations: [
        allocation({
          id: 'alloc-car',
          financialGoalId: 'goal-car',
          assetId: 'tcb',
          role: 'contribution',
          kind: 'percent',
          percent: 90,
          monthlyContribution: 20 * M,
        }),
      ],
      // The wallet was 30tr when the goal was set up; an edited event since then
      // drove it below zero.
      assets: [{ id: 'tcb', type: 'bank_account', currentValue: -168 * M }],
    });

    const usage = await service.assetGoalUsage('hh-1', 'tcb');

    expect(usage.assetValue).toBe(-168 * M);
    // Nothing is there, so nothing is claimed, committed or free — and none of
    // those may go negative.
    expect(usage.claimedAmount).toBe(0);
    expect(usage.committedAmount).toBe(0);
    expect(usage.freeAmount).toBe(0);
    expect(usage.unassignedAmount).toBe(0);
    expect(usage.items[0].countedValue).toBe(0);
  });

  /**
   * Same floor, on the path that decides WHICH wallet a nameless spend comes out
   * of. Reporting a negative "promised" amount would rank an overdrawn wallet as
   * the least-promised money and send the spend straight at it.
   */
  it('promises nothing from an overdrawn wallet when ordering by claim', async () => {
    const { service } = setup({
      goal: goal({ id: 'goal-car', name: 'car', priority: 'high' }),
      allocations: [
        allocation({
          id: 'alloc-car',
          financialGoalId: 'goal-car',
          assetId: 'tcb',
          role: 'contribution',
          kind: 'percent',
          percent: 90,
          monthlyContribution: 20 * M,
        }),
      ],
      assets: [{ id: 'tcb', type: 'bank_account', currentValue: -168 * M }],
    });

    const byWallet = await service.goalClaimsByWallet(
      'hh-1',
      new Map([['tcb', -168 * M]]),
    );

    expect(byWallet.get('tcb')?.amount).toBe(0);
    // The goal still backs the wallet, so its priority is still reported — only
    // the amount is floored.
    expect(byWallet.get('tcb')?.topPriority).toBe('high');
  });

  // Gold behind a goal is spoken for just as much as a wallet is — the asset
  // page is where someone asks "can I use this?", and a holding must answer.
  it('includes holdings, not just contribution shares', async () => {
    const { service } = setup({
      goal: goal({ id: 'goal-car' }),
      allocations: [
        allocation({
          id: 'alloc-1',
          financialGoalId: 'goal-car',
          assetId: 'stocks',
          role: 'holding',
          allocatedAmount: 40 * M,
        }),
      ],
    });

    const usage = await service.assetGoalUsage('hh-1', 'stocks');

    expect(usage.items).toHaveLength(1);
    expect(usage.freeAmount).toBe(60 * M);
  });

  // An asset nothing claims is entirely free — not an error, and not empty of
  // information: "all of it is yours to use" is the answer.
  it('reports the whole value free when no goal claims it', async () => {
    const { service } = setup({ allocations: [] });

    const usage = await service.assetGoalUsage('hh-1', 'vcb');

    expect(usage.items).toHaveLength(0);
    expect(usage.freeAmount).toBe(200 * M);
  });

  // A percent claim tracks the asset, so what is free tracks it too.
  it('resolves a percent claim against the live value', async () => {
    const { service } = setup({
      goal: goal({ id: 'goal-car' }),
      allocations: [
        allocation({
          id: 'alloc-1',
          financialGoalId: 'goal-car',
          assetId: 'stocks',
          kind: 'percent',
          role: 'holding',
          allocatedAmount: null,
          percent: 25,
        }),
      ],
    });

    const usage = await service.assetGoalUsage('hh-1', 'stocks');

    expect(usage.items[0]).toMatchObject({ currentValue: 25 * M });
    expect(usage.freeAmount).toBe(75 * M);
  });
});
