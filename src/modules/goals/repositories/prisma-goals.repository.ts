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
    const household = await this.assertHousehold(goal.householdId);
    await this.prisma.financialGoal.create({
      data: {
        id: goal.id,
        householdId: goal.householdId,
        name: goal.name,
        targetAmount: goal.targetAmount,
        currentAmount: goal.currentAmount,
        deadline: this.toDate(nullableDate(goal.deadline)),
        priority: goal.priority,
        note: goal.note,
        createdById: household.createdBy,
      } as any,
    });
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
