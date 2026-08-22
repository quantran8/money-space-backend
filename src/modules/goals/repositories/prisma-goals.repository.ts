import { Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '../../../common/utils/uuid';
import {
  mapFinancialGoal,
  mapGoalAssetAllocation,
  mapHousehold,
  nullableDate,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import {
  FinancialGoal,
  GoalAssetAllocation,
} from '../entities/financial-goal.entity';
import { Household } from '../../households/entities/household.entity';
import { GoalsRepository } from './goals.repository.interface';

@Injectable()
export class PrismaGoalsRepository
  extends PrismaRepository
  implements GoalsRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  createId(_prefix: string): string {
    return uuidv7();
  }

  async assertHousehold(householdId: string): Promise<Household> {
    const household = await this.prisma.household.findFirst({
      where: { id: householdId, deletedAt: null },
    });

    if (!household) {
      throw new NotFoundException(`Household "${householdId}" was not found`);
    }

    return mapHousehold(household);
  }

  async findFinancialGoalsByHousehold(
    householdId: string,
  ): Promise<FinancialGoal[]> {
    // Progress is not stored here — the caller resolves it from the goal's
    // allocations against live asset values.
    const goals = await this.prisma.financialGoal.findMany({
      where: { householdId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    return goals.map((goal) => mapFinancialGoal(goal));
  }

  async findFinancialGoalById(
    householdId: string,
    goalId: string,
  ): Promise<FinancialGoal | undefined> {
    const goal = await this.prisma.financialGoal.findFirst({
      where: { id: goalId, householdId, deletedAt: null },
    });
    if (!goal) {
      return undefined;
    }

    return mapFinancialGoal(goal);
  }

  async insertFinancialGoal(goal: FinancialGoal): Promise<void> {
    // Single round-trip: insert the goal while deriving `created_by` from the
    // household row in one statement. If the household doesn't exist (or is
    // soft-deleted) the SELECT yields no row, nothing is inserted, and we
    // surface a 404 — matching the previous assertHousehold behaviour.
    const targetDate = this.toDate(nullableDate(goal.targetDate));

    // `updated_at` is NOT NULL with no DB default — Prisma's @updatedAt fills it
    // on ORM writes, but a raw INSERT must set it explicitly.
    //
    // A goal stores no progress figure of its own — it is the sum of the shares
    // of real assets recorded in `goal_asset_allocations`, resolved on read.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO financial_goals
        (id, household_id, name, target_amount,
         planned_monthly_contribution, baseline_contribution_amount,
         target_date, priority, note, created_by, updated_at)
      SELECT
        ${goal.id}::uuid,
        h.id,
        ${goal.name},
        ${goal.targetAmount}::numeric,
        ${goal.plannedMonthlyContribution}::numeric,
        ${goal.baselineContributionAmount}::numeric,
        ${targetDate}::date,
        ${goal.priority}::"GoalPriority",
        ${goal.note},
        h.created_by,
        now()
      FROM households h
      WHERE h.id = ${goal.householdId}::uuid
        AND h.deleted_at IS NULL
    `;

    if (inserted === 0) {
      throw new NotFoundException(
        `Household "${goal.householdId}" was not found`,
      );
    }
  }

  async updateFinancialGoal(
    goalId: string,
    goal: FinancialGoal,
  ): Promise<void> {
    await this.prisma.financialGoal.updateMany({
      where: { id: goalId, householdId: goal.householdId, deletedAt: null },
      data: {
        name: goal.name,
        targetAmount: goal.targetAmount,
        plannedMonthlyContribution: goal.plannedMonthlyContribution,
        // No progress field to write: it is derived from the goal's
        // allocations, which are edited through their own routes.
        targetDate: this.toDate(nullableDate(goal.targetDate)),
        priority: goal.priority,
        note: goal.note,
      },
    });
  }

  async updatePlannedMonthlyContribution(
    householdId: string,
    goalId: string,
    plannedMonthlyContribution: number | null,
  ): Promise<void> {
    await this.prisma.financialGoal.updateMany({
      where: { id: goalId, householdId, deletedAt: null },
      data: { plannedMonthlyContribution },
    });
  }

  async deleteFinancialGoal(goalId: string): Promise<void> {
    await this.prisma.financialGoal.updateMany({
      where: { id: goalId },
      data: { deletedAt: new Date() },
    });
  }

  async unlinkFinancialGoalFromMoneyEvents(
    householdId: string,
    goalId: string,
  ): Promise<void> {
    // Scoped to the household as well as the goal. Goal ids are uuids so a
    // collision is not the worry — an unscoped write is simply a write nobody
    // bounded, and every other statement here carries the household.
    await this.prisma.moneyEvent.updateMany({
      where: { householdId, financialGoalId: goalId },
      data: { financialGoalId: null },
    });
  }

  /**
   * Every LIVE claim in the household — live in BOTH directions.
   *
   * `asset: { deletedAt: null }` is not defensive noise. Assets are
   * soft-deleted, so the `onDelete: Cascade` declared on this relation never
   * fires: deleting an asset leaves its allocations sitting there, pointing at
   * a row nothing else will ever return. Those orphans then reach the goal
   * screens, where the asset resolves to no value and no name — a claim shown
   * against money that no longer exists.
   *
   * The filter lives HERE rather than in `GoalsService` because it is a
   * condition on what an allocation IS, not on what one caller wants. Every
   * consumer reads goal progress from these rows; a service-level filter would
   * have to be repeated at each of them, and the next one added would forget.
   *
   * `findAllocationById` deliberately does NOT filter this way — see there.
   */
  async findAllocationsByHousehold(
    householdId: string,
  ): Promise<GoalAssetAllocation[]> {
    const rows = await this.prisma.goalAssetAllocation.findMany({
      where: { householdId, deletedAt: null, asset: { deletedAt: null } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => mapGoalAssetAllocation(row));
  }

  /** One goal's live claims. Skips deleted assets for the reason above. */
  async findAllocationsByGoal(
    householdId: string,
    goalId: string,
  ): Promise<GoalAssetAllocation[]> {
    const rows = await this.prisma.goalAssetAllocation.findMany({
      where: {
        householdId,
        financialGoalId: goalId,
        deletedAt: null,
        asset: { deletedAt: null },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => mapGoalAssetAllocation(row));
  }

  /**
   * Purchases that moved money BETWEEN two assets of the same goal — a wallet
   * that feeds it paying for a holding it also counts.
   *
   * The wallet drop would otherwise read as a withdrawal from the goal, when in
   * fact the goal's total did not move at all: the household changed the form
   * it holds. Both ends are required to be in `assetIds`; buying an asset
   * OUTSIDE the goal really does take money out of it and must keep showing up.
   *
   * Only possible because `asset_purchase` now carries `from_asset_id`. Before
   * that, a wallet falling and gold rising were two unrelated facts.
   */
  async findGoalConversionPurchases(
    householdId: string,
    assetIds: string[],
  ): Promise<Array<{ date: string; amount: number }>> {
    if (assetIds.length < 2) {
      return [];
    }
    const rows = await this.prisma.moneyEvent.findMany({
      where: {
        householdId,
        deletedAt: null,
        eventType: 'asset_purchase',
        fromAssetId: { in: assetIds },
        toAssetId: { in: assetIds },
      },
      select: { eventDate: true, amount: true },
      orderBy: { eventDate: 'asc' },
    });
    return rows.map((row) => ({
      date: row.eventDate.toISOString().slice(0, 10),
      amount: Number(row.amount),
    }));
  }

  /**
   * One claim by id, WITHOUT the `asset.deletedAt` filter the list reads apply.
   *
   * The lists answer "what does this goal hold?", so a claim over a deleted
   * asset does not belong in them. This answers "which row am I editing?", and
   * an orphaned claim is exactly the row a household needs to be able to reach
   * — to delete it, or to point it somewhere real. Filtering here would make
   * the orphan invisible AND unremovable.
   */
  async findAllocationById(
    householdId: string,
    allocationId: string,
  ): Promise<GoalAssetAllocation | undefined> {
    const row = await this.prisma.goalAssetAllocation.findFirst({
      where: { id: allocationId, householdId, deletedAt: null },
    });
    return row ? mapGoalAssetAllocation(row) : undefined;
  }

  async insertAllocation(allocation: GoalAssetAllocation): Promise<void> {
    // `created_by` is derived from the household row in the same statement, the
    // way `insertFinancialGoal` does — one round-trip, and a missing household
    // inserts nothing rather than writing an orphan.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO goal_asset_allocations
        (id, household_id, financial_goal_id, asset_id, kind, role,
         monthly_contribution, share_percent, allocated_amount, percent, note,
         created_by, updated_at)
      SELECT
        ${allocation.id}::uuid,
        h.id,
        ${allocation.financialGoalId}::uuid,
        ${allocation.assetId}::uuid,
        ${allocation.kind}::"GoalAllocationKind",
        ${allocation.role}::"GoalAllocationRole",
        ${allocation.monthlyContribution}::numeric,
        ${allocation.sharePercent}::numeric,
        ${allocation.allocatedAmount}::numeric,
        ${allocation.percent}::numeric,
        ${allocation.note},
        h.created_by,
        now()
      FROM households h
      WHERE h.id = ${allocation.householdId}::uuid
        AND h.deleted_at IS NULL
    `;

    if (inserted === 0) {
      throw new NotFoundException(
        `Household "${allocation.householdId}" was not found`,
      );
    }
  }

  async updateAllocation(
    allocationId: string,
    allocation: GoalAssetAllocation,
  ): Promise<void> {
    await this.prisma.goalAssetAllocation.updateMany({
      where: {
        id: allocationId,
        householdId: allocation.householdId,
        deletedAt: null,
      },
      data: {
        kind: allocation.kind,
        role: allocation.role,
        monthlyContribution: allocation.monthlyContribution,
        sharePercent: allocation.sharePercent,
        // Both are written every time, so switching kind clears the column the
        // new kind does not use — the CHECK constraint requires exactly one.
        allocatedAmount: allocation.allocatedAmount,
        percent: allocation.percent,
        note: allocation.note,
      },
    });
  }

  async deleteAllocation(
    householdId: string,
    allocationId: string,
  ): Promise<void> {
    await this.prisma.goalAssetAllocation.updateMany({
      where: { id: allocationId, householdId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  async deleteAllocationsByGoal(
    householdId: string,
    goalId: string,
  ): Promise<void> {
    await this.prisma.goalAssetAllocation.updateMany({
      where: { householdId, financialGoalId: goalId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Every live claim over one asset. No `asset.deletedAt` filter on purpose —
   * see the interface: the caller is asking about an asset being removed.
   */
  async findAllocationsByAsset(
    householdId: string,
    assetId: string,
  ): Promise<GoalAssetAllocation[]> {
    const rows = await this.prisma.goalAssetAllocation.findMany({
      where: { householdId, assetId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => mapGoalAssetAllocation(row));
  }

  async deleteAllocationsByAsset(
    householdId: string,
    assetId: string,
  ): Promise<void> {
    await this.prisma.goalAssetAllocation.updateMany({
      where: { householdId, assetId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }
}
