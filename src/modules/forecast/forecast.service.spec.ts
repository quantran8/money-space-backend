import { BadRequestException } from '@nestjs/common';
import { todayInTimeZone } from '../../common/utils/clock';
import { ForecastService } from './forecast.service';
import { UNASSIGNED_WALLET_ID } from './domain/what-if';
import { CacheService } from '../../common/cache/cache.service';
import type { ForecastBundle } from './repositories/forecast.repository.interface';

const M = 1_000_000;
// Must match the service's clock: it anchors to the household timezone
// (Asia/Ho_Chi_Minh), which is a day ahead of UTC for part of every day.
const TODAY = todayInTimeZone();

function bundle(over: Partial<ForecastBundle> = {}): ForecastBundle {
  return {
    assets: [
      {
        assetId: 'a1',
        name: 'VCB',
        value: 100 * M,
        liquidity: 'usable_now',
        type: 'bank_account',
        valueUpdatedAt: TODAY,
      },
    ],
    cashflowEvents: [],
    ...over,
  };
}

function setup(over: Partial<ForecastBundle> = {}, goal?: unknown) {
  const loadForecastBundle = jest.fn(async () => bundle(over));
  const forecastRepository = {
    assertHousehold: jest.fn(async () => ({}) as never),
    loadForecastBundle,
  } as never;
  const goalsRepository = {
    findFinancialGoalById: jest.fn(async () => goal),
  } as never;
  // Progress resolution is exercised by `goal-progress.spec.ts`; here it only
  // has to return the fixture's own figure so the projection assertions below
  // stay about the projection.
  const goalsService = {
    resolveProgressAmount: jest.fn(
      async (_householdId: string, target: { currentAmount: number }) =>
        target.currentAmount,
    ),
    // What the goals claim of the liquid total. Its own arithmetic lives in
    // `goal-progress.spec.ts`; these fixtures have no goals, so 0 is the honest
    // figure and keeps the flexible-money assertions about cash flow.
    resolveGoalCommitments: jest.fn(async () => 0),
    // The per-goal cost of a hypothetical spend. Its arithmetic is exercised by
    // `spend-impact.spec.ts`; here it only has to exist and be shaped right.
    spendImpact: jest.fn(
      async (_hh: string, assetId: string, amount: number) => ({
        householdId: 'hh-1',
        assetId,
        assetValue: 0,
        amount,
        assetValueAfter: 0,
        totalReduction: 0,
        totalPaceReduction: 0,
        totalSetAsideReduction: 0,
        goals: [],
        exceedsWallet: false,
      }),
    ),
    // What-if's household-wide form. Its arithmetic lives in
    // `goal-progress.spec.ts` / `spend-impact.spec.ts`; these fixtures have no
    // goals, so zeroes are the honest answer.
    spendImpactAcrossWallets: jest.fn(async () => ({
      totalReduction: 0,
      totalPaceReduction: 0,
      totalSetAsideReduction: 0,
      goals: [],
    })),
    goalClaimsByWallet: jest.fn(
      async () => new Map<string, { amount: number; topPriority: null }>(),
    ),
  } as never;
  // A real CacheService with no Redis configured: `wrap` falls straight through
  // to the loader, so these tests exercise the actual cached code path rather
  // than a stub, while staying offline.
  const cache = new CacheService();
  const service = new ForecastService(
    forecastRepository,
    goalsRepository,
    goalsService,
    cache,
  );
  return {
    service,
    loadForecastBundle,
    forecastRepository,
    goalsRepository,
    goalsService,
    cache,
  };
}

describe('ForecastService — goal commitments measured after outflows', () => {
  /**
   * The regression this guards: goal money was measured against today's
   * balances while `lowestProjectedBalance` had already subtracted the same
   * outflows, so every outflow was charged twice and the hero read negative.
   */
  it('passes wallet values with the outflow already taken out', async () => {
    const { service } = setup({
      assets: [
        {
          assetId: 'tcb',
          name: 'TCB',
          value: 22 * M,
          liquidity: 'usable_now',
          type: 'bank_account',
          valueUpdatedAt: TODAY,
        },
      ],
      cashflowEvents: [
        {
          id: 'bill',
          name: 'Bill',
          direction: 'outgoing',
          amount: 5 * M,
          expectedDate: TODAY,
          recurrence: 'once',
          recurrenceEndDate: null,
          requirement: 'required',
          certainty: 'confirmed',
          status: 'expected',
          settlementAssetId: 'tcb',
        },
      ],
    });
    const resolve = (
      service as unknown as {
        goalsService: { resolveGoalCommitments: jest.Mock };
      }
    ).goalsService.resolveGoalCommitments;

    await service.flexibleMoney('hh-1', 30);

    // Lowered values, plus the ORIGINAL as the percent basis: a percent claim
    // must not shrink while unassigned money is still in the wallet.
    expect(resolve).toHaveBeenCalledWith(
      'hh-1',
      new Map([['tcb', 17 * M]]),
      new Map([['tcb', 22 * M]]),
    );
  });

  it('leaves wallets whole when the outflow settles elsewhere', async () => {
    const { service } = setup({
      assets: [
        {
          assetId: 'tcb',
          name: 'TCB',
          value: 22 * M,
          liquidity: 'usable_now',
          type: 'bank_account',
          valueUpdatedAt: TODAY,
        },
      ],
      cashflowEvents: [
        {
          id: 'bill',
          name: 'Bill',
          direction: 'outgoing',
          amount: 5 * M,
          expectedDate: TODAY,
          recurrence: 'once',
          recurrenceEndDate: null,
          requirement: 'required',
          certainty: 'confirmed',
          status: 'expected',
          settlementAssetId: 'other-wallet',
        },
      ],
    });
    const resolve = (
      service as unknown as {
        goalsService: { resolveGoalCommitments: jest.Mock };
      }
    ).goalsService.resolveGoalCommitments;

    await service.flexibleMoney('hh-1', 30);

    expect(resolve).toHaveBeenCalledWith(
      'hh-1',
      new Map([['tcb', 22 * M]]),
      new Map([['tcb', 22 * M]]),
    );
  });
});

describe('ForecastService.parseHorizon', () => {
  it('defaults to 30', () => {
    const { service } = setup();
    expect(service.parseHorizon(undefined)).toBe(30);
    expect(service.parseHorizon('')).toBe(30);
  });

  it.each([[7], [30], [60], [90]])('accepts %s', (days) => {
    const { service } = setup();
    expect(service.parseHorizon(String(days))).toBe(days);
  });

  it.each([['45'], ['0'], ['-1'], ['abc'], ['365']])('rejects %s', (value) => {
    const { service } = setup();
    expect(() => service.parseHorizon(value)).toThrow(BadRequestException);
  });
});

describe('ForecastService.whatIf', () => {
  const spend = { amount: 30 * M, plannedDate: TODAY };

  it('loads the forecast bundle exactly ONCE for before + after', async () => {
    const { service, loadForecastBundle } = setup();

    await service.whatIf('hh-1', spend);

    // Running the engine twice must not mean querying twice.
    expect(loadForecastBundle).toHaveBeenCalledTimes(1);
  });

  it('reduces flexible money by the spend', async () => {
    const { service } = setup();

    const result = await service.whatIf('hh-1', spend);

    expect(result.before.lowestProjectedBalance).toBe(100 * M);
    expect(result.after.lowestProjectedBalance).toBe(70 * M);
    expect(result.delta.lowestProjectedBalance).toBe(-30 * M);
  });

  /**
   * The regression: both sides called `computeFlexibleMoney` with NO goal
   * commitments, so what-if reported flexible money that ignored every goal —
   * a larger figure than Home showed for the same household, from the screen
   * whose entire job is being trusted about consequences.
   */
  it('measures goal money on BOTH sides, like every other reading', async () => {
    const { service } = setup();
    const resolve = (
      service as unknown as {
        goalsService: { resolveGoalCommitments: jest.Mock };
      }
    ).goalsService.resolveGoalCommitments;
    resolve.mockClear();

    await service.whatIf('hh-1', spend);

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('classifies a comfortable spend', async () => {
    const { service } = setup();
    const result = await service.whatIf('hh-1', { ...spend, amount: 1 * M });
    expect(result.resultType).toBe('comfortable');
  });

  it('classifies a spend that goes negative as tight', async () => {
    const { service } = setup();
    const result = await service.whatIf('hh-1', { ...spend, amount: 150 * M });
    expect(result.resultType).toBe('tight');
  });

  /**
   * §26D: what-if persists NOTHING. There is no `what_if_scenarios` table and
   * there must not be one. This asserts the guarantee rather than trusting it —
   * the repositories expose only reads, and nothing else is touched.
   */
  it('never writes: only the read methods are ever called', async () => {
    const { service, forecastRepository, goalsRepository } = setup();

    await service.whatIf('hh-1', spend);

    const called = (repo: object) =>
      Object.entries(repo)
        .filter(([, value]) => jest.isMockFunction(value))
        .filter(([, value]) => (value as jest.Mock).mock.calls.length > 0)
        .map(([name]) => name);

    // `loadForecastBundle` alone: access is settled by `HouseholdAccessGuard`
    // before the handler runs, so the service no longer re-asserts the
    // household.
    expect(called(forecastRepository).sort()).toEqual(['loadForecastBundle']);
    expect(called(goalsRepository)).toEqual([]);
  });

  it.each([
    ['zero amount', { amount: 0 }],
    ['negative amount', { amount: -1 }],
  ])('rejects %s', async (_label, patch) => {
    const { service } = setup();
    await expect(
      service.whatIf('hh-1', { ...spend, ...patch }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a planned date outside the horizon', async () => {
    const { service } = setup();
    await expect(
      service.whatIf('hh-1', { ...spend, plannedDate: '2099-01-01' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a goal that does not belong to the household', async () => {
    const { service } = setup({}, undefined);
    await expect(
      service.whatIf('hh-1', { ...spend, goalId: 'nope' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('reports the time cost against a goal', async () => {
    const { service } = setup(
      {},
      {
        id: 'g1',
        targetAmount: 1000 * M,
        currentAmount: 600 * M,
        plannedMonthlyContribution: 10 * M,
        targetDate: 'No deadline',
      },
    );

    const result = await service.whatIf('hh-1', { ...spend, goalId: 'g1' });

    // 30M spend against a 10M/month pace ≈ 3 months later.
    expect(result.delta.goalDelayMonths).toBe(3);
    expect(result.delta.goalDelayDays).toBe(90);
    expect(result.before.goal?.estimatedMonthsToGoal).toBe(40);
    expect(result.after.goal?.estimatedMonthsToGoal).toBe(43);
  });

  it('cannot express a time cost when the goal has no declared pace', async () => {
    const { service } = setup(
      {},
      {
        id: 'g1',
        targetAmount: 1000 * M,
        currentAmount: 600 * M,
        plannedMonthlyContribution: null,
        targetDate: 'No deadline',
      },
    );

    const result = await service.whatIf('hh-1', { ...spend, goalId: 'g1' });

    expect(result.delta.goalDelayMonths).toBeNull();
    expect(result.after.goal?.reason).toBe('no_contribution');
  });

  it('carries the assumptions through so the client can explain the number', async () => {
    const { service } = setup();
    const result = await service.whatIf('hh-1', spend);
    expect(result.assumptions.map((a) => a.code)).toContain('horizon_days');
  });

  /**
   * The invariant the funding block is only readable under: the three semantic
   * parts have to account for exactly the money that left the wallets. If they
   * drift, the screen tells the household their spend came from somewhere it
   * did not — which is worse than showing no breakdown at all.
   */
  it('splits the covered spend into free + pace + set-aside, with nothing lost', async () => {
    const { service } = setup();

    const result = await service.whatIf('hh-1', spend);
    const { free, fromPace, fromSetAside } = result.fundingSource;

    expect(free + fromPace + fromSetAside).toBe(
      spend.amount - result.goalImpact.uncovered,
    );
    // The goal-facing halves are the SAME figures the goal block reports —
    // one spend must not be costed two different ways.
    expect(fromPace).toBe(result.goalImpact.totalPaceReduction);
    expect(fromSetAside).toBe(result.goalImpact.totalSetAsideReduction);
  });

  it('names the wallets the money came out of, and never a wallet that gave nothing', async () => {
    const { service } = setup();

    const result = await service.whatIf('hh-1', spend);

    // Untouched wallets are noise, not evidence.
    expect(result.fundingSource.wallets.every((w) => w.taken > 0)).toBe(true);
    // What the wallets gave up IS the covered spend — the literal and semantic
    // splits describe one spend, not two.
    expect(
      result.fundingSource.wallets.reduce((sum, w) => sum + w.taken, 0),
    ).toBe(spend.amount - result.goalImpact.uncovered);
    // Named, not just identified: an asset id is not something a household can
    // recognise as one of their own accounts.
    expect(result.fundingSource.wallets[0]?.name).toBeTruthy();
  });

  it('reports the shortfall as uncovered rather than inventing money to spend', async () => {
    const { service } = setup();

    // Far beyond every wallet combined.
    const result = await service.whatIf('hh-1', { ...spend, amount: 900 * M });
    const { free, fromPace, fromSetAside, wallets } = result.fundingSource;

    expect(result.goalImpact.uncovered).toBeGreaterThan(0);
    // Still exact: the parts cover what actually left, and the rest is named
    // as missing instead of being padded into `free`.
    expect(free + fromPace + fromSetAside).toBe(
      900 * M - result.goalImpact.uncovered,
    );
    expect(wallets.reduce((sum, w) => sum + w.taken, 0)).toBe(
      900 * M - result.goalImpact.uncovered,
    );
  });
});

describe('ForecastService.whatIf — funding a spend by selling an asset', () => {
  /**
   * 500tr liquid across two wallets, 600tr of stock, 200tr of gold, plus an
   * insurance policy that is long-term but NOT sellable. The household in the
   * feature's own worked example.
   */
  function household() {
    return {
      assets: [
        {
          assetId: 'bank-a',
          name: 'Bank A',
          value: 300 * M,
          liquidity: 'usable_now' as const,
          type: 'bank_account' as const,
          valueUpdatedAt: TODAY,
        },
        {
          assetId: 'bank-b',
          name: 'Bank B',
          value: 200 * M,
          liquidity: 'usable_now' as const,
          type: 'bank_account' as const,
          valueUpdatedAt: TODAY,
        },
        {
          assetId: 'stock',
          name: 'Chứng khoán',
          value: 600 * M,
          liquidity: 'long_term' as const,
          type: 'stock' as const,
          valueUpdatedAt: TODAY,
        },
        {
          assetId: 'gold',
          name: 'Vàng',
          value: 200 * M,
          liquidity: 'long_term' as const,
          type: 'gold' as const,
          valueUpdatedAt: TODAY,
        },
        {
          assetId: 'insurance',
          name: 'Bảo hiểm',
          value: 400 * M,
          liquidity: 'long_term' as const,
          type: 'insurance' as const,
          valueUpdatedAt: TODAY,
        },
      ],
      cashflowEvents: [],
    };
  }

  const spend = { amount: 800 * M, plannedDate: TODAY };

  it('reports what is usable today and what the spend is short of it', async () => {
    const { service } = setup(household());

    const result = await service.whatIf('hh-1', spend);

    expect(result.liquidity.liquidAvailable).toBe(500 * M);
    expect(result.liquidity.shortfall).toBe(300 * M);
  });

  it('measures the shortfall and `uncovered` as one figure', async () => {
    const { service } = setup(household());

    const result = await service.whatIf('hh-1', spend);

    // Two names for the same fact. Asserted so they cannot drift apart.
    expect(result.liquidity.shortfall).toBe(result.goalImpact.uncovered);
  });

  it('reports no shortfall when the spend fits', async () => {
    const { service } = setup(household());

    const result = await service.whatIf('hh-1', { ...spend, amount: 100 * M });

    expect(result.liquidity.shortfall).toBe(0);
    expect(result.fundingOptions).toEqual([]);
  });

  it('offers only sellable, non-liquid assets, biggest first', async () => {
    const { service } = setup(household());

    const result = await service.whatIf('hh-1', spend);

    // Wallets are transferred from, not sold; insurance is not sellable.
    expect(result.fundingOptions.map((option) => option.assetId)).toEqual([
      'stock',
      'gold',
    ]);
  });

  it('loads the bundle ONCE even with a third engine run', async () => {
    const { service, loadForecastBundle } = setup(household());

    await service.whatIf('hh-1', {
      ...spend,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: 'bank-a',
      },
    });

    expect(loadForecastBundle).toHaveBeenCalledTimes(1);
  });

  it('raises today’s money by the proceeds, without inventing an inflow', async () => {
    const { service } = setup(household());

    const result = await service.whatIf('hh-1', {
      ...spend,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: 'bank-a',
      },
    });

    /**
     * The guard against modelling the sale as a synthetic INCOMING event: that
     * shape leaves `flexibleMoneyToday` untouched (the starting balance never
     * sees it) and can even move it the wrong way by becoming the next certain
     * inflow. A t0 conversion moves it by exactly the proceeds.
     */
    expect(result.afterSale).not.toBeNull();
    expect(
      result.afterSale!.flexibleMoneyToday - result.after.flexibleMoneyToday,
    ).toBe(300 * M);
    expect(result.deltaWithSale?.flexibleMoneyToday).toBe(300 * M);
  });

  it('closes the shortfall it was asked to close', async () => {
    const { service } = setup(household());

    const result = await service.whatIf('hh-1', {
      ...spend,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: 'bank-a',
      },
    });

    // 500tr liquid + 300tr raised = the full 800tr.
    expect(result.goalImpact.uncovered).toBe(0);
    expect(result.afterSale!.lowestProjectedBalance).toBe(0);
  });

  it('does not subtract the proceeds twice', async () => {
    const { service } = setup(household());

    const result = await service.whatIf('hh-1', {
      ...spend,
      amount: 300 * M,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: 'bank-a',
      },
    });

    // Sell 300tr, spend 300tr: the low point lands exactly where it started.
    expect(result.afterSale!.lowestProjectedBalance).toBe(
      result.before.lowestProjectedBalance,
    );
  });

  it('echoes the sale, including the wallet the engine chose', async () => {
    const { service } = setup(household());

    const result = await service.whatIf('hh-1', {
      ...spend,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: 'bank-a',
      },
    });

    expect(result.assetSale).toMatchObject({
      amount: 300 * M,
      // No fee on a hypothetical.
      netProceeds: 300 * M,
      lines: [
        {
          assetId: 'stock',
          name: 'Chứng khoán',
          amount: 300 * M,
          assetValueBefore: 600 * M,
          assetValueAfter: 300 * M,
        },
      ],
    });
    // The household named no wallet; the engine did, and says which.
    expect(result.assetSale!.receivingAssetId).toBeTruthy();
    expect(result.assetSale!.receivingName).toBeTruthy();
  });

  it('measures the goal cost against the sold asset, not just the wallets', async () => {
    const { service, goalsService } = setup(household());

    await service.whatIf('hh-1', {
      ...spend,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: 'bank-a',
      },
    });

    const [, before, after] = (
      goalsService as unknown as {
        spendImpactAcrossWallets: jest.Mock;
      }
    ).spendImpactAcrossWallets.mock.calls[0] as [
      string,
      Map<string, number>,
      Map<string, number>,
    ];

    // The whole point: a goal backed by the stock must see it shrink.
    expect([...before]).toEqual([...before]); // placeholder
    expect(before.get('stock')).toBe(600 * M);
    expect(after.get('stock')).toBe(300 * M);
  });

  it('nets the conversion to zero across the goal attribution maps', async () => {
    const { service, goalsService } = setup(household());

    // Sell 300tr and spend exactly the proceeds, so only the conversion moves.
    await service.whatIf('hh-1', {
      ...spend,
      amount: 300 * M,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: 'bank-a',
      },
    });

    const [, before, after] = (
      goalsService as unknown as { spendImpactAcrossWallets: jest.Mock }
    ).spendImpactAcrossWallets.mock.calls[0] as [
      string,
      Map<string, number>,
      Map<string, number>,
    ];

    /**
     * The before map is PRE-sale and the after map carries both the proceeds
     * and the spend. Raising a wallet by 300tr and spending 300tr from it must
     * leave every wallet exactly where it started — that is what makes the
     * conversion net to zero and proves the proceeds are not counted twice.
     */
    for (const [assetId, value] of before) {
      if (assetId === 'stock') continue;
      expect(after.get(assetId)).toBe(value);
    }
    // …while the sold asset is the one thing that really did move.
    expect(before.get('stock')).toBe(600 * M);
    expect(after.get('stock')).toBe(300 * M);
  });

  it('does not credit a wallet with money the sale supplied', async () => {
    const { service } = setup(household());

    const result = await service.whatIf('hh-1', {
      ...spend,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: 'bank-a',
      },
    });

    /**
     * The bug this guards: `before` was read off the sale-topped-up map, so a
     * wallet holding 300tr reported having held 600tr and paid all of it. Its
     * own money and the proceeds are different facts.
     */
    const held = result.fundingSource.wallets.reduce(
      (sum, wallet) => sum + wallet.before,
      0,
    );
    expect(held).toBe(result.liquidity.liquidAvailable);
    expect(result.fundingSource.fromSale).toBe(300 * M);
  });

  it('names the sale as its own funding source, not free money', async () => {
    const { service } = setup(household());

    const result = await service.whatIf('hh-1', {
      ...spend,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: 'bank-a',
      },
    });

    const { fromSale, free, fromPace, fromSetAside } = result.fundingSource;
    // The parts still account for the whole covered spend…
    expect(fromSale + free + fromPace + fromSetAside).toBe(800 * M);
    // …and the 300tr raised is not reported as money already lying around.
    expect(fromSale).toBe(300 * M);
    expect(free).toBe(500 * M);
  });

  it('stops reporting a shortfall once the sale has covered it', async () => {
    const { service } = setup(household());

    const result = await service.whatIf('hh-1', {
      ...spend,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: 'bank-a',
      },
    });

    // Saying "còn thiếu 300tr" after raising exactly 300tr is simply wrong —
    // and it is what kept the funding CTA on screen after it had been used.
    expect(result.liquidity.shortfall).toBe(0);
  });

  it('never lets the sold asset pay for the spend directly', async () => {
    const { service, goalsService } = setup(household());

    await service.whatIf('hh-1', {
      ...spend,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: 'bank-a',
      },
    });

    /**
     * `goalClaimsByWallet` feeds `spreadAcrossWallets`. An illiquid asset in
     * that map would be drained to pay for the purchase with no sale at all.
     */
    const claimCalls = (
      goalsService as unknown as { goalClaimsByWallet: jest.Mock }
    ).goalClaimsByWallet.mock.calls;
    const spendMaps = claimCalls
      .map(([, map]) => map as Map<string, number>)
      // The funding-options lookup deliberately asks about non-liquid assets.
      .filter((map) => !map.has('gold'));

    for (const map of spendMaps) {
      expect(map.has('stock')).toBe(false);
      expect(map.has('insurance')).toBe(false);
    }
  });

  it('leaves the payload untouched when no sale was asked for', async () => {
    const { service } = setup(household());

    const result = await service.whatIf('hh-1', spend);

    expect(result.assetSale).toBeNull();
    expect(result.afterSale).toBeNull();
    expect(result.deltaWithSale).toBeNull();
  });

  it('still writes nothing on the sale path', async () => {
    const { service, forecastRepository, goalsRepository } = setup(household());

    await service.whatIf('hh-1', {
      ...spend,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: 'bank-a',
      },
    });

    const called = (mock: object) =>
      Object.entries(mock)
        .filter(([, fn]) => (fn as jest.Mock).mock?.calls.length > 0)
        .map(([name]) => name);

    expect(called(forecastRepository)).toEqual(['loadForecastBundle']);
    expect(called(goalsRepository)).toEqual([]);
  });

  it('keeps analytics bucketed, never the sale amount', async () => {
    const { service } = setup(household());
    const logged: string[] = [];
    jest
      .spyOn(service['logger'], 'log')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });

    await service.whatIf('hh-1', {
      ...spend,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: 'bank-a',
      },
    });

    const line = logged.find((entry) => entry.startsWith('what_if_run'))!;
    expect(line).toContain('"hasAssetSale":true');
    expect(line).not.toContain('300000000');
    expect(line).not.toContain('800000000');
  });

  it('credits the wallet the household chose, not one of its own picking', async () => {
    const { service } = setup(household());

    const intoB = await service.whatIf('hh-1', {
      ...spend,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: 'bank-b',
      },
    });

    expect(intoB.assetSale!.receivingAssetId).toBe('bank-b');
    expect(intoB.assetSale!.receivingName).toBe('Bank B');
    // The wallet that actually grew is the one that was named.
    const b = intoB.fundingSource.wallets.find((w) => w.assetId === 'bank-b');
    expect(b?.fromSale).toBe(300 * M);
    expect(
      intoB.fundingSource.wallets.find((w) => w.assetId === 'bank-a')?.fromSale,
    ).toBe(0);
  });

  /**
   * Short 500tr against 300tr of gold and 250tr of stocks, no single holding
   * closes the gap — the case a one-asset step could not express at all.
   */
  it('sells several holdings into one wallet to close a gap neither could', async () => {
    const { service } = setup(household());

    const result = await service.whatIf('hh-1', {
      ...spend,
      amount: 1000 * M,
      assetSale: {
        lines: [
          { assetId: 'stock', amount: 350 * M },
          { assetId: 'gold', amount: 150 * M },
        ],
        toAssetId: 'bank-a',
      },
    });

    expect(result.assetSale!.amount).toBe(500 * M);
    expect(result.assetSale!.lines.map((line) => line.assetId)).toEqual([
      'stock',
      'gold',
    ]);
    // Each holding is reported at what it actually gave up.
    expect(result.assetSale!.lines[0]).toMatchObject({
      assetValueBefore: 600 * M,
      assetValueAfter: 250 * M,
    });
    expect(result.assetSale!.lines[1]).toMatchObject({
      assetValueBefore: 200 * M,
      assetValueAfter: 50 * M,
    });
    // 500tr liquid + 500tr raised = the full 1 tỷ.
    expect(result.goalImpact.uncovered).toBe(0);
    expect(
      result.afterSale!.flexibleMoneyToday - result.after.flexibleMoneyToday,
    ).toBe(500 * M);
  });

  /**
   * A household tracking gold and stocks but no bank account has no wallet to
   * name — and used to reach a required field it could not satisfy.
   */
  it('sells for a household that holds no wallet at all', async () => {
    const walletless = {
      assets: household().assets.filter(
        (asset) => asset.liquidity !== 'usable_now',
      ),
      cashflowEvents: [],
    };
    const { service } = setup(walletless);

    const result = await service.whatIf('hh-1', {
      ...spend,
      amount: 300 * M,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 300 * M }],
        toAssetId: UNASSIGNED_WALLET_ID,
      },
    });

    expect(result.assetSale!.receivingAssetId).toBe(UNASSIGNED_WALLET_ID);
    // The proceeds are real, usable money: the spend is covered by them alone.
    expect(result.liquidity.liquidAvailable).toBe(0);
    expect(
      result.afterSale!.flexibleMoneyToday - result.after.flexibleMoneyToday,
    ).toBe(300 * M);
  });

  /**
   * The bills the household sees must be judged in the world they are looking
   * at. Reading the sale-less forecast reported items as broken by a shortfall
   * the proceeds had already covered, and printed a running balance that
   * ignored the money raised.
   */
  it('judges at-risk bills against the world AFTER the sale', async () => {
    const withBill = {
      ...household(),
      cashflowEvents: [
        {
          id: 'bill',
          name: 'Học phí',
          direction: 'outgoing' as const,
          amount: 4 * M,
          expectedDate: TODAY,
          recurrence: 'once' as const,
          recurrenceEndDate: null,
          requirement: 'required' as const,
          certainty: 'confirmed' as const,
          status: 'expected' as const,
        },
      ],
    };

    // 500tr liquid, a 4tr bill, and a 600tr spend: without selling the bill
    // breaks.
    const { service } = setup(withBill);
    const withoutSale = await service.whatIf('hh-1', {
      ...spend,
      amount: 600 * M,
    });
    expect(withoutSale.newlyAtRisk).toHaveLength(1);

    // Selling enough to fund the spend leaves the bill payable, so it is not
    // reported at all — and `obligationsCovered` agrees with that list.
    const { service: service2 } = setup(withBill);
    const withSale = await service2.whatIf('hh-1', {
      ...spend,
      amount: 600 * M,
      assetSale: {
        lines: [{ assetId: 'stock', amount: 200 * M }],
        toAssetId: 'bank-a',
      },
    });
    expect(withSale.newlyAtRisk).toEqual([]);
    expect(withSale.obligationsCovered).toBe(true);
  });

  const W = 'bank-a';
  it.each([
    [
      'an unknown asset',
      { lines: [{ assetId: 'nope', amount: 10 * M }], toAssetId: W },
    ],
    [
      'a wallet as the thing sold',
      { lines: [{ assetId: W, amount: 10 * M }], toAssetId: 'bank-b' },
    ],
    [
      'a non-sellable asset',
      { lines: [{ assetId: 'insurance', amount: 10 * M }], toAssetId: W },
    ],
    [
      'a zero amount',
      { lines: [{ assetId: 'stock', amount: 0 }], toAssetId: W },
    ],
    [
      'a negative amount',
      { lines: [{ assetId: 'stock', amount: -1 }], toAssetId: W },
    ],
    [
      'more than the asset holds',
      { lines: [{ assetId: 'stock', amount: 601 * M }], toAssetId: W },
    ],
    [
      'an unknown receiving wallet',
      { lines: [{ assetId: 'stock', amount: 10 * M }], toAssetId: 'nope' },
    ],
    // Proceeds must land somewhere spendable, or the sale funds nothing.
    [
      'a non-liquid receiving asset',
      { lines: [{ assetId: 'stock', amount: 10 * M }], toAssetId: 'gold' },
    ],
    [
      'receiving into an asset being sold',
      { lines: [{ assetId: 'stock', amount: 10 * M }], toAssetId: 'stock' },
    ],
    ['no lines at all', { lines: [], toAssetId: W }],
    // The same holding twice would sell more of it than exists.
    [
      'the same asset on two lines',
      {
        lines: [
          { assetId: 'stock', amount: 300 * M },
          { assetId: 'stock', amount: 300 * M },
        ],
        toAssetId: W,
      },
    ],
    // The sentinel is for a household with NO wallet, never a way to park
    // money outside the reach of the goals that sit in front of an account.
    [
      'the unassigned sentinel while the household holds wallets',
      {
        lines: [{ assetId: 'stock', amount: 10 * M }],
        toAssetId: UNASSIGNED_WALLET_ID,
      },
    ],
  ])('refuses %s', async (_label, assetSale) => {
    const { service } = setup(household());

    await expect(
      service.whatIf('hh-1', { ...spend, assetSale }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ForecastService caching', () => {
  /**
   * Injects a working in-memory cache into the service built by `setup()`.
   * `CacheService` refuses to build a client under NODE_ENV=test by design, so
   * the fake stands in for Redis while the real `wrap`/`get`/`set` logic runs.
   */
  function withCache(over: Partial<ForecastBundle> = {}) {
    const store = new Map<string, string>();
    const fakeRedis = {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      set: (key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve('OK');
      },
      on: () => undefined,
    };
    const ctx = setup(over);
    (ctx.cache as unknown as { client: unknown }).client = fakeRedis;
    return { ...ctx, store };
  }

  it('loads the bundle once across repeated forecast reads', async () => {
    const { service, loadForecastBundle } = withCache();

    await service.forecast('hh-1', 30);
    await service.forecast('hh-1', 30);

    expect(loadForecastBundle).toHaveBeenCalledTimes(1);
  });

  it('serves flexibleMoney, financialState and the bundle from one load', async () => {
    // All three are pure functions of the forecast, so caching `forecast()`
    // must cover every endpoint that derives from it.
    const { service, loadForecastBundle } = withCache();

    await service.forecast('hh-1', 30);
    await service.flexibleMoney('hh-1', 30);
    await service.financialState('hh-1', 30);
    await service.forecastBundle('hh-1', 30);

    expect(loadForecastBundle).toHaveBeenCalledTimes(1);
  });

  it('keys by horizon, so a different horizon is not served stale', async () => {
    const { service, loadForecastBundle } = withCache();

    await service.forecast('hh-1', 30);
    await service.forecast('hh-1', 90);

    expect(loadForecastBundle).toHaveBeenCalledTimes(2);
  });

  it('keys by household, so one household never sees another figures', async () => {
    const { service, loadForecastBundle } = withCache();

    await service.forecast('hh-1', 30);
    await service.forecast('hh-2', 30);

    expect(loadForecastBundle).toHaveBeenCalledTimes(2);
  });

  it('never caches an explicit asOfDate', async () => {
    // Only the snapshot backfill passes a date; caching those would grow the
    // key space with entries nothing reads twice.
    const { service, loadForecastBundle, store } = withCache();

    await service.forecast('hh-1', 30, TODAY);
    await service.forecast('hh-1', 30, TODAY);

    expect(loadForecastBundle).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(0);
  });

  it('does not let a what-if read poison the cached forecast', async () => {
    // what-if runs the engine over a hypothetical event; that result must never
    // become the household's real cached forecast.
    const { service, store } = withCache();

    await service.forecast('hh-1', 30);
    const cachedBefore = store.get('money-space:hh:hh-1:forecast:30');

    await service.whatIf('hh-1', {
      amount: 5 * M,
      plannedDate: TODAY,
      horizonDays: 30,
    });

    expect(store.get('money-space:hh:hh-1:forecast:30')).toBe(cachedBefore);
  });
});
