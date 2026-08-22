import { PrismaGoalsRepository } from './prisma-goals.repository';
import type { PrismaService } from '../../../database/prisma/prisma.service';

/**
 * Which allocation reads skip claims over a DELETED asset.
 *
 * Assets are soft-deleted, so `onDelete: Cascade` on this relation never fires
 * and the claim outlives the asset. Every list read has to exclude those, or a
 * goal goes on showing a wallet the household removed — with no value and no
 * name, because the asset resolves to nothing. `findAllocationById` must NOT
 * exclude them: it answers "which row am I editing?", and an orphaned claim is
 * exactly the row a household needs to be able to reach in order to remove it.
 *
 * Asserted on the `where` clause rather than against a database, matching how
 * the rest of this suite runs. That is enough here: the filter IS the fix, and
 * a missing one is precisely the regression this pins.
 */
describe('PrismaGoalsRepository — deleted assets in allocation reads', () => {
  type Query = { where: Record<string, unknown> };

  function setup() {
    // Typed so the assertions can read `where` off the recorded call without
    // TypeScript inferring a zero-argument mock.
    const findMany = jest.fn(async (_query: Query) => []);
    const findFirst = jest.fn(async (_query: Query) => null);
    const prismaService = {
      client: () => ({ goalAssetAllocation: { findMany, findFirst } }),
    } as unknown as PrismaService;
    return {
      repository: new PrismaGoalsRepository(prismaService),
      findMany,
      findFirst,
    };
  }

  it('skips claims over a deleted asset when listing a household', async () => {
    const { repository, findMany } = setup();
    await repository.findAllocationsByHousehold('hh-1');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          householdId: 'hh-1',
          deletedAt: null,
          asset: { deletedAt: null },
        }),
      }),
    );
  });

  it("skips claims over a deleted asset when listing one goal's", async () => {
    const { repository, findMany } = setup();
    await repository.findAllocationsByGoal('hh-1', 'goal-car');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          householdId: 'hh-1',
          financialGoalId: 'goal-car',
          deletedAt: null,
          asset: { deletedAt: null },
        }),
      }),
    );
  });

  // Deliberately unfiltered — see the note above.
  it('still finds a single claim whose asset is gone', async () => {
    const { repository, findFirst } = setup();
    await repository.findAllocationById('hh-1', 'alloc-1');
    const where = findFirst.mock.calls[0]![0].where;
    expect(where).not.toHaveProperty('asset');
  });

  // The delete flow asks ABOUT an asset on its way out, so filtering it here
  // would always return nothing — and the household would be told the asset
  // backs no goals right before its claims were silently orphaned.
  it('finds claims over the very asset being deleted', async () => {
    const { repository, findMany } = setup();
    await repository.findAllocationsByAsset('hh-1', 'asset-vcb');
    const where = findMany.mock.calls[0]![0].where;
    expect(where).toEqual(
      expect.objectContaining({ householdId: 'hh-1', assetId: 'asset-vcb', deletedAt: null }),
    );
    expect(where).not.toHaveProperty('asset');
  });
});
