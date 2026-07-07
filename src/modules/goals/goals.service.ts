import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { FinancialGoal } from './entities/financial-goal.entity';
import { toGoalCard } from '../../common/utils/money-space.utils';
import type { CreateFinancialGoalDto } from './dto/create-financial-goal.dto';
import type { UpdateFinancialGoalDto } from './dto/update-financial-goal.dto';
import { GOALS_REPOSITORY } from './repositories/goals.repository.interface';
import type { GoalsRepository } from './repositories/goals.repository.interface';

@Injectable()
export class GoalsService {
  constructor(
    @Inject(GOALS_REPOSITORY)
    private readonly goalsRepository: GoalsRepository,
  ) {}

  async listFinancialGoals(householdId: string) {
    await this.goalsRepository.assertHousehold(householdId);
    const goals = await this.goalsRepository.findFinancialGoalsByHousehold(householdId);
    const items = goals.map((goal) => toGoalCard(goal));
    return {
      householdId,
      items,
      total: items.length,
    };
  }

  async getFinancialGoal(householdId: string, goalId: string) {
    return toGoalCard(await this.ensureFinancialGoal(householdId, goalId));
  }

  async createFinancialGoal(
    householdId: string,
    payload: CreateFinancialGoalDto,
  ) {
    await this.goalsRepository.assertHousehold(householdId);
    const goal: FinancialGoal = {
      id: this.goalsRepository.createId('goal'),
      householdId,
      name: payload.name.trim(),
      currentAmount: payload.currentAmount ?? 0,
      targetAmount: payload.targetAmount,
      priority: payload.priority,
      note: payload.note?.trim() ?? '',
      deadline: payload.deadline ?? 'No deadline',
    };

    await this.goalsRepository.insertFinancialGoal(goal);
    return toGoalCard(goal);
  }

  async updateFinancialGoal(
    householdId: string,
    goalId: string,
    payload: UpdateFinancialGoalDto,
  ) {
    const goal = await this.ensureFinancialGoal(householdId, goalId);
    const next: FinancialGoal = {
      ...goal,
      ...payload,
      id: goal.id,
      householdId: goal.householdId,
      name: payload.name?.trim() ?? goal.name,
      currentAmount: payload.currentAmount ?? goal.currentAmount,
      targetAmount: payload.targetAmount ?? goal.targetAmount,
      note: payload.note?.trim() ?? goal.note,
      deadline: payload.deadline ?? goal.deadline,
      priority: payload.priority ?? goal.priority,
    };

    await this.goalsRepository.updateFinancialGoal(goalId, next);
    return toGoalCard(next);
  }

  async deleteFinancialGoal(householdId: string, goalId: string) {
    await this.ensureFinancialGoal(householdId, goalId);
    await this.goalsRepository.deleteFinancialGoal(goalId);
    await this.goalsRepository.unlinkFinancialGoalFromMoneyEvents(goalId);
    return {
      deleted: true,
      goalId,
    };
  }

  private async ensureFinancialGoal(householdId: string, goalId: string) {
    await this.goalsRepository.assertHousehold(householdId);
    const goal = await this.goalsRepository.findFinancialGoalById(householdId, goalId);
    if (!goal) {
      throw new NotFoundException(`Financial goal "${goalId}" was not found`);
    }
    return goal;
  }
}
