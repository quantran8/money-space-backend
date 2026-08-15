import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import {
  FinancialGoal,
  NO_TARGET_DATE,
} from './entities/financial-goal.entity';
import { toGoalCard } from '../../common/utils/money-space.utils';
import { todayInTimeZone } from '../../common/utils/clock';
import { projectGoal } from './domain/goal-projection';
import type { CreateFinancialGoalDto } from './dto/create-financial-goal.dto';
import type { UpdateFinancialGoalDto } from './dto/update-financial-goal.dto';
import { GOALS_REPOSITORY } from './repositories/goals.repository.interface';
import type { GoalsRepository } from './repositories/goals.repository.interface';

@Injectable()
export class GoalsService {
  constructor(
    @Inject(GOALS_REPOSITORY)
    private readonly goalsRepository: GoalsRepository,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * `?include=projection` attaches each goal's projection (§26C) to the list.
   *
   * Opt-in rather than always-on: the Goals screen needs it, the goal picker in
   * a form does not, and projecting N goals the caller will not render is work
   * nobody asked for.
   *
   * The projection is computed HERE, from the pure `projectGoal` in this
   * module's own `domain/`, rather than by calling ForecastService — Forecast
   * imports Goals, so the reverse edge would be a cycle.
   */
  async listFinancialGoals(householdId: string, include?: string) {
    // No `assertHousehold`: `HouseholdAccessGuard` already validated the
    // household + membership for this route, so a second lookup of the same
    // row buys nothing but a query.
    const goals =
      await this.goalsRepository.findFinancialGoalsByHousehold(householdId);

    const wantsProjection = (include ?? '')
      .split(',')
      .map((part) => part.trim())
      .includes('projection');
    const asOfDate = todayInTimeZone();

    const items = goals.map((goal) => ({
      ...toGoalCard(goal),
      ...(wantsProjection
        ? { projection: this.projectionFor(goal, asOfDate) }
        : {}),
    }));

    return {
      householdId,
      items,
      total: items.length,
    };
  }

  async getFinancialGoal(householdId: string, goalId: string) {
    const goal = await this.ensureFinancialGoal(householdId, goalId);
    return {
      ...toGoalCard(goal),
      projection: this.projectionFor(goal, todayInTimeZone()),
    };
  }

  /** One goal's projection, shaped for `projectGoal`. */
  private projectionFor(goal: FinancialGoal, asOfDate: string) {
    return projectGoal({
      goalId: goal.id,
      targetAmount: goal.targetAmount,
      currentAmount: goal.currentAmount,
      plannedMonthlyContribution: goal.plannedMonthlyContribution,
      // `NO_TARGET_DATE` is a wire sentinel, not a date. Passing it straight
      // through would make every undated goal look like it was due on the
      // string "No deadline".
      targetDate:
        goal.targetDate && goal.targetDate !== NO_TARGET_DATE
          ? goal.targetDate
          : null,
      status: 'active',
      asOfDate,
    });
  }

  async createFinancialGoal(
    householdId: string,
    payload: CreateFinancialGoalDto,
  ) {
    // `insertFinancialGoal` asserts the household exists (and needs its row to
    // resolve `createdById`), so we don't assert it a second time here.
    const currentAmount = payload.currentAmount ?? 0;
    if (currentAmount < 0) {
      throw new BadRequestException('currentAmount cannot be negative');
    }
    const plannedMonthlyContribution =
      payload.plannedMonthlyContribution ?? null;
    if (plannedMonthlyContribution !== null && plannedMonthlyContribution < 0) {
      throw new BadRequestException(
        'plannedMonthlyContribution cannot be negative',
      );
    }

    const goal: FinancialGoal = {
      id: this.goalsRepository.createId('goal'),
      householdId,
      name: payload.name.trim(),
      // Accepted on create so onboarding can record savings that predate the
      // app. After this, only goal_contribution events may move it.
      currentAmount,
      targetAmount: payload.targetAmount,
      plannedMonthlyContribution,
      priority: payload.priority,
      note: payload.note?.trim() ?? '',
      targetDate: payload.targetDate ?? NO_TARGET_DATE,
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
    if (
      payload.plannedMonthlyContribution != null &&
      payload.plannedMonthlyContribution < 0
    ) {
      throw new BadRequestException(
        'plannedMonthlyContribution cannot be negative',
      );
    }
    const next: FinancialGoal = {
      ...goal,
      ...payload,
      id: goal.id,
      householdId: goal.householdId,
      name: payload.name?.trim() ?? goal.name,
      // Never taken from the payload: only a goal_contribution money event may
      // move progress, so the stored total can't drift from the event history.
      // `UpdateFinancialGoalDto` omits the field, this is the runtime guard.
      currentAmount: goal.currentAmount,
      targetAmount: payload.targetAmount ?? goal.targetAmount,
      plannedMonthlyContribution:
        payload.plannedMonthlyContribution ?? goal.plannedMonthlyContribution,
      note: payload.note?.trim() ?? goal.note,
      targetDate: payload.targetDate ?? goal.targetDate,
      priority: payload.priority ?? goal.priority,
    };

    await this.goalsRepository.updateFinancialGoal(goalId, next);
    return toGoalCard(next);
  }

  async deleteFinancialGoal(householdId: string, goalId: string) {
    await this.ensureFinancialGoal(householdId, goalId);
    // The soft-delete and the money-event unlink must land together.
    await this.prisma.runInTransaction(async () => {
      await this.goalsRepository.deleteFinancialGoal(goalId);
      await this.goalsRepository.unlinkFinancialGoalFromMoneyEvents(goalId);
    });
    return {
      deleted: true,
      goalId,
    };
  }

  private async ensureFinancialGoal(householdId: string, goalId: string) {
    await this.goalsRepository.assertHousehold(householdId);
    const goal = await this.goalsRepository.findFinancialGoalById(
      householdId,
      goalId,
    );
    if (!goal) {
      throw new NotFoundException(`Financial goal "${goalId}" was not found`);
    }
    return goal;
  }
}
