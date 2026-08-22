import { ConflictException } from '@nestjs/common';
import { AssetsService } from './assets.service';
import type { Asset } from './entities/asset.entity';
import type { AssetsRepository } from './repositories/assets.repository.interface';
import type { PrismaService } from '../../database/prisma/prisma.service';
import type { MarketDataService } from '../market-data/market-data.service';

/**
 * Deleting an asset that other records point at.
 *
 * Assets are SOFT-deleted, so the `onDelete: Cascade` every one of those
 * relations declares never fires. Before this, the delete simply left them
 * behind: a goal went on listing a wallet the household had removed, its share
 * of the progress silently reading zero, and nothing anywhere said so. These
 * cases pin both halves of the fix — the refusal, and what the confirmed
 * delete actually clears.
 */
describe('AssetsService.deleteAsset — records pointing at the asset', () => {
  const asset: Asset = {
    id: 'asset-vcb',
    householdId: 'hh-1',
    name: 'Vietcombank',
    type: 'bank_account',
    valuationMode: 'manual',
    liquidity: 'usable_now',
    currency: 'VND',
    note: '',
    status: 'active',
    manualValue: 100_000_000,
  };

  function setup(
    options: {
      allocations?: Array<{
        id: string;
        financialGoalId: string;
        assetId: string;
        role: string;
      }>;
      /** Claims the affected goal has LEFT, as read back per goal. */
      remainingByGoal?: Record<
        string,
        Array<{ assetId: string; role: string; monthlyContribution?: number }>
      >;
      goals?: Array<{ id: string; name: string; priority: string }>;
      cashflowEvents?: Array<Record<string, unknown>>;
      debts?: Array<Record<string, unknown>>;
    } = {},
  ) {
    const allocations = options.allocations ?? [];
    const calls = {
      deleteAsset: jest.fn(async () => undefined),
      deleteAssetValueHistory: jest.fn(async () => undefined),
      deleteAssetDetails: jest.fn(async () => undefined),
      unlinkAssetFromMoneyEvents: jest.fn(async () => undefined),
      unlinkAssetFromCashflowEvents: jest.fn(async () => undefined),
      unlinkAssetFromDebts: jest.fn(async () => undefined),
      deleteAllocationsByAsset: jest.fn(async () => undefined),
      updatePlannedMonthlyContribution: jest.fn(async () => undefined),
    };

    const repository = {
      assertHousehold: jest.fn(async () => ({}) as never),
      findAssetById: jest.fn(async () => asset),
      deleteAsset: calls.deleteAsset,
      deleteAssetValueHistory: calls.deleteAssetValueHistory,
      deleteAssetDetails: calls.deleteAssetDetails,
      unlinkAssetFromMoneyEvents: calls.unlinkAssetFromMoneyEvents,
    } as unknown as AssetsRepository;

    const goalsRepository = {
      findAllocationsByAsset: jest.fn(async () => allocations),
      findFinancialGoalsByHousehold: jest.fn(async () => options.goals ?? []),
      findAllocationsByGoal: jest.fn(async (_hh: string, goalId: string) => {
        const remaining = options.remainingByGoal?.[goalId];
        if (remaining) {
          return remaining;
        }
        return allocations.filter(
          (allocation) => allocation.financialGoalId === goalId,
        );
      }),
      deleteAllocationsByAsset: calls.deleteAllocationsByAsset,
      updatePlannedMonthlyContribution: calls.updatePlannedMonthlyContribution,
    } as never;

    const cashflowEventsRepository = {
      findCashflowEventsByHousehold: jest.fn(
        async () => options.cashflowEvents ?? [],
      ),
      unlinkAssetFromCashflowEvents: calls.unlinkAssetFromCashflowEvents,
    } as never;

    const debtsRepository = {
      findDebtsByHousehold: jest.fn(async () => options.debts ?? []),
      unlinkAssetFromDebts: calls.unlinkAssetFromDebts,
    } as never;

    const prisma = {
      runInTransaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
    } as unknown as PrismaService;
    const marketData = {
      getMarketPrices: jest.fn().mockResolvedValue([]),
    } as unknown as MarketDataService;
    const audit = { record: jest.fn() } as never;

    return {
      service: new AssetsService(
        repository,
        prisma,
        marketData,
        audit,
        goalsRepository,
        cashflowEventsRepository,
        debtsRepository,
      ),
      calls,
      audit: audit as unknown as { record: jest.Mock },
    };
  }

  it('deletes an unreferenced asset without asking', async () => {
    const { service, calls } = setup();
    await expect(service.deleteAsset('hh-1', 'asset-vcb')).resolves.toEqual(
      expect.objectContaining({ deleted: true, assetId: 'asset-vcb' }),
    );
    expect(calls.deleteAsset).toHaveBeenCalled();
  });

  // The refusal is the whole point: without it the goal keeps a claim on a row
  // nothing will return again.
  it('refuses while a goal still claims it, and writes nothing', async () => {
    const { service, calls } = setup({
      goals: [{ id: 'goal-car', name: 'Mua xe', priority: 'high' }],
      allocations: [
        {
          id: 'alloc-1',
          financialGoalId: 'goal-car',
          assetId: 'asset-vcb',
          role: 'contribution',
        },
      ],
    });

    await expect(
      service.deleteAsset('hh-1', 'asset-vcb'),
    ).rejects.toBeInstanceOf(ConflictException);
    // Nothing may have landed — a refused delete that half-ran is worse than
    // either outcome.
    expect(calls.deleteAsset).not.toHaveBeenCalled();
    expect(calls.deleteAllocationsByAsset).not.toHaveBeenCalled();
  });

  it('reports what a delete would detach, naming the goal', async () => {
    const { service } = setup({
      goals: [{ id: 'goal-car', name: 'Mua xe', priority: 'high' }],
      allocations: [
        {
          id: 'alloc-1',
          financialGoalId: 'goal-car',
          assetId: 'asset-vcb',
          role: 'contribution',
        },
      ],
      cashflowEvents: [
        {
          id: 'ev-1',
          name: 'Tiền điện',
          expectedDate: '2026-09-01',
          status: 'expected',
          settlementAssetId: 'asset-vcb',
        },
      ],
      debts: [
        {
          id: 'debt-1',
          name: 'Vay mẹ',
          status: 'active',
          repaymentAssetId: 'asset-vcb',
        },
      ],
    });

    const impact = await service.getAssetDeleteImpact('hh-1', 'asset-vcb');
    expect(impact.isClear).toBe(false);
    expect(impact.goals).toHaveLength(1);
    expect(impact.goals[0]).toEqual(
      expect.objectContaining({ name: 'Mua xe', losesLastWallet: true }),
    );
    expect(impact.goalsLosingLastWallet).toEqual([
      { id: 'goal-car', name: 'Mua xe' },
    ]);
    expect(impact.cashflowEvents).toHaveLength(1);
    expect(impact.debts).toHaveLength(1);
  });

  // `cascade` is the household's confirmation. Everything pointing at the asset
  // has to be cleared in the SAME transaction, or the delete leaves exactly the
  // orphans it was supposed to prevent.
  it('clears every reference once confirmed', async () => {
    const { service, calls } = setup({
      goals: [{ id: 'goal-car', name: 'Mua xe', priority: 'high' }],
      allocations: [
        {
          id: 'alloc-1',
          financialGoalId: 'goal-car',
          assetId: 'asset-vcb',
          role: 'contribution',
        },
      ],
      remainingByGoal: { 'goal-car': [] },
      cashflowEvents: [
        {
          id: 'ev-1',
          name: 'Tiền điện',
          expectedDate: '2026-09-01',
          status: 'expected',
          settlementAssetId: 'asset-vcb',
        },
      ],
      debts: [
        {
          id: 'debt-1',
          name: 'Vay mẹ',
          status: 'active',
          repaymentAssetId: 'asset-vcb',
        },
      ],
    });

    const result = await service.deleteAsset(
      'hh-1',
      'asset-vcb',
      'user-1',
      true,
    );

    expect(calls.deleteAsset).toHaveBeenCalled();
    expect(calls.deleteAllocationsByAsset).toHaveBeenCalledWith(
      'hh-1',
      'asset-vcb',
    );
    expect(calls.unlinkAssetFromCashflowEvents).toHaveBeenCalledWith(
      'hh-1',
      'asset-vcb',
    );
    expect(calls.unlinkAssetFromDebts).toHaveBeenCalledWith(
      'hh-1',
      'asset-vcb',
    );
    // The asset's own detail rows go too — otherwise a deleted holding's ticker
    // stays in the market-data poll universe forever.
    expect(calls.deleteAssetDetails).toHaveBeenCalledWith('asset-vcb');
    expect(result.detached.goals).toBe(1);
    expect(result.detached.goalsLeftWithoutWallet).toBe(1);
  });

  // `planned_monthly_contribution` is a MIRROR of the surviving claims. Left
  // alone, the goal would advertise a pace partly funded by a wallet that no
  // longer exists.
  it("rewrites the affected goal's pace from what survives", async () => {
    const { service, calls } = setup({
      goals: [{ id: 'goal-car', name: 'Mua xe', priority: 'high' }],
      allocations: [
        {
          id: 'alloc-1',
          financialGoalId: 'goal-car',
          assetId: 'asset-vcb',
          role: 'contribution',
        },
      ],
      // One wallet survives, still declaring 4tr a month.
      remainingByGoal: {
        'goal-car': [
          {
            assetId: 'asset-cash',
            role: 'contribution',
            monthlyContribution: 4_000_000,
          },
        ],
      },
    });

    await service.deleteAsset('hh-1', 'asset-vcb', 'user-1', true);

    expect(calls.updatePlannedMonthlyContribution).toHaveBeenCalledWith(
      'hh-1',
      'goal-car',
      4_000_000,
    );
  });
});
