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
    allocatedAmount: 50 * M,
    percent: null,
    note: '',
    ...over,
  };
}

const WALLET = { id: 'vcb', type: 'bank_account', currentValue: 200 * M };
const STOCKS = { id: 'stocks', type: 'stock', currentValue: 100 * M };

function setup(options: {
  goal?: FinancialGoal;
  allocations?: GoalAssetAllocation[];
  assets?: Array<{ id: string; type: string; currentValue: number }>;
} = {}) {
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

  // Money is only ever put into a goal through a wallet. Backed by gold alone,
  // the figure moves on the gold price and "did we keep our pace?" has no source
  // to read at all.
  it('refuses a goal backed only by holdings', async () => {
    const { service, insertFinancialGoal } = setup();
    await expect(
      service.createFinancialGoal('hh-1', {
        ...withAssets,
        allocations: [
          { assetId: 'stocks', kind: 'fixed', allocatedAmount: 50 * M },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(insertFinancialGoal).not.toHaveBeenCalled();
  });

  // "10tr a month" is really "6tr out of the salary account and 4tr in cash".
  it('stores the goal pace as the sum of its wallets', async () => {
    const { service, insertFinancialGoal } = setup({
      assets: [
        WALLET,
        { id: 'cash-box', type: 'cash', currentValue: 50 * M },
      ],
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
      allocations: [{ assetId: 'vcb', kind: 'fixed', allocatedAmount: 100 * M }],
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
      allocations: [{ assetId: 'vcb', kind: 'fixed', allocatedAmount: 100 * M }],
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

  // Removing the last wallet would leave exactly the goal that create refuses
  // to make: one with nothing to be saved into.
  it('refuses to remove the goal\'s only wallet', async () => {
    const { service } = setup({
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
    ).rejects.toBeInstanceOf(BadRequestException);
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
      assets: [
        WALLET,
        { id: 'cash-box', type: 'cash', currentValue: 50 * M },
      ],
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
