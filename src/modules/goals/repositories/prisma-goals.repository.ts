import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  mapFinancialGoal,
  mapHousehold,
  nullableDate,
} from '../../../common/repositories/money-space.mapper';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { FinancialGoal } from '../entities/financial-goal.entity';
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
    return randomUUID();
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

    return goal ? mapFinancialGoal(goal) : undefined;
  }

  async insertFinancialGoal(goal: FinancialGoal): Promise<void> {
    // Single round-trip: insert the goal while deriving `created_by` from the
    // household row in one statement. If the household doesn't exist (or is
    // soft-deleted) the SELECT yields no row, nothing is inserted, and we
    // surface a 404 — matching the previous assertHousehold behaviour.
    const deadline = this.toDate(nullableDate(goal.deadline));

    // `updated_at` is NOT NULL with no DB default — Prisma's @updatedAt fills it
    // on ORM writes, but a raw INSERT must set it explicitly.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO financial_goals
        (id, household_id, name, target_amount, current_amount,
         deadline, priority, note, created_by, updated_at)
      SELECT
        ${goal.id}::uuid,
        h.id,
        ${goal.name},
        ${goal.targetAmount}::numeric,
        ${goal.currentAmount}::numeric,
        ${deadline}::date,
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

  async updateFinancialGoal(goalId: string, goal: FinancialGoal): Promise<void> {
    await this.prisma.financialGoal.updateMany({
      where: { id: goalId, householdId: goal.householdId, deletedAt: null },
      data: {
        name: goal.name,
        targetAmount: goal.targetAmount,
        currentAmount: goal.currentAmount,
        deadline: this.toDate(nullableDate(goal.deadline)),
        priority: goal.priority,
        note: goal.note,
      } as any,
    });
  }

  async deleteFinancialGoal(goalId: string): Promise<void> {
    await this.prisma.financialGoal.updateMany({
      where: { id: goalId },
      data: { deletedAt: new Date() },
    });
  }

  async unlinkFinancialGoalFromMoneyEvents(goalId: string): Promise<void> {
    await this.prisma.moneyEvent.updateMany({
      where: { financialGoalId: goalId },
      data: { financialGoalId: null },
    });
  }
}
