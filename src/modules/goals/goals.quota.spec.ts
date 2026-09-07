import { GoalsService } from './goals.service';
import { EntitlementService } from '../billing/entitlement.service';
import { PremiumRequiredException } from '../billing/entitlement.errors';
import {
  freeEntitlement,
  premiumEntitlement,
} from '../billing/test-support/entitlement.fixture';
import type { Entitlement } from '../billing/entities/entitlement.entity';
import type { FinancialGoal } from './entities/financial-goal.entity';

const M = 1_000_000;

const WALLET = { id: 'asset-wallet', type: 'bank_account', currentValue: 100 * M };

function goal(over: Partial<FinancialGoal> = {}): FinancialGoal {
  return {
    id: 'goal-1',
    householdId: 'hh-1',
    name: 'Mua xe',
    targetAmount: 500 * M,
    plannedMonthlyContribution: null,
    baselineContributionAmount: null,
    priority: 'medium',
    status: 'active',
    note: '',
    targetDate: 'No deadline',
    ...over,
  };
}

/**
 * The goal quota.
 *
 * A REAL `EntitlementService` is used (with a stubbed repository) rather than a
 * mock of `assertQuota`, so these cases exercise the actual comparison the
 * production path makes.
 */
function makeService(entitlement: Entitlement, goals: FinancialGoal[]) {
  const insertFinancialGoal = jest.fn(async () => undefined);

  const repository = {
    assertHousehold: jest.fn(async () => ({}) as never),
    createId: () => 'goal-new',
    findAllocationsByHousehold: jest.fn(async () => []),
    findFinancialGoalsByHousehold: jest.fn(async () => goals),
    insertAllocation: jest.fn(async () => undefined),
    insertFinancialGoal,
    updatePlannedMonthlyContribution: jest.fn(async () => undefined),
  } as never;

  const entitlements = new EntitlementService(
    { findSubscription: jest.fn(async () => null) } as never,
    { get: jest.fn(async () => undefined), set: jest.fn(), del: jest.fn() } as never,
    {} as never,
  );
  // The row-to-entitlement resolution has its own spec; what is under test here
  // is what `createFinancialGoal` does with the answer.
  jest.spyOn(entitlements, 'forHousehold').mockResolvedValue(entitlement);

  const service = new GoalsService(
    repository,
    { runInTransaction: jest.fn(async (fn: () => Promise<unknown>) => fn()) } as never,
    { getActiveAssetRecords: jest.fn(async () => [WALLET]) } as never,
    { findGoalProgressPoints: jest.fn(async () => []) } as never,
    { findCashflowEventsByHousehold: jest.fn(async () => []) } as never,
    entitlements,
  );

  return { service, insertFinancialGoal };
}

const payload = {
  name: 'Quỹ dự phòng',
  targetAmount: 100 * M,
  priority: 'medium' as const,
  allocations: [{ assetId: WALLET.id, kind: 'fixed' as const, allocatedAmount: 10 * M }],
};

describe('createFinancialGoal — the plan ceiling', () => {
  it('lets a free household create its second goal', async () => {
    const { service, insertFinancialGoal } = makeService(freeEntitlement(), [
      goal({ id: 'goal-1' }),
    ]);

    await service.createFinancialGoal('hh-1', payload);
    expect(insertFinancialGoal).toHaveBeenCalled();
  });

  it('refuses the third goal with 402 and the goal_quota reason', async () => {
    const { service, insertFinancialGoal } = makeService(freeEntitlement(), [
      goal({ id: 'goal-1' }),
      goal({ id: 'goal-2' }),
    ]);

    await expect(service.createFinancialGoal('hh-1', payload)).rejects.toBeInstanceOf(
      PremiumRequiredException,
    );
    // Refused BEFORE the write, so a rejected create leaves nothing behind.
    expect(insertFinancialGoal).not.toHaveBeenCalled();
  });

  it('does not count completed or cancelled goals against the ceiling', async () => {
    // The decision this pins: a household that COMPLETES two goals must still
    // be able to start a third. Counting finished goals would punish them for
    // succeeding, at the exact moment the app has just worked.
    const { service, insertFinancialGoal } = makeService(freeEntitlement(), [
      goal({ id: 'goal-1', status: 'completed' }),
      goal({ id: 'goal-2', status: 'completed' }),
      goal({ id: 'goal-3', status: 'cancelled' }),
    ]);

    await service.createFinancialGoal('hh-1', payload);
    expect(insertFinancialGoal).toHaveBeenCalled();
  });

  it('never refuses a premium household', async () => {
    const { service, insertFinancialGoal } = makeService(
      premiumEntitlement(),
      Array.from({ length: 20 }, (_, i) => goal({ id: `goal-${i}` })),
    );

    await service.createFinancialGoal('hh-1', payload);
    expect(insertFinancialGoal).toHaveBeenCalled();
  });
});
