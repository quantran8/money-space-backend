import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { GoalsService } from './goals.service';
import type { CreateFinancialGoalDto } from './dto/create-financial-goal.dto';
import type { UpdateFinancialGoalDto } from './dto/update-financial-goal.dto';
import type {
  CreateGoalAllocationDto,
  UpdateGoalAllocationDto,
} from './dto/goal-allocation.dto';

@Controller('api/households/:householdId/financial-goals')
export class GoalsController {
  constructor(private readonly goalsService: GoalsService) {}

  /** `?include=projection` attaches each goal's §26C projection. */
  @Get()
  listFinancialGoals(
    @Param('householdId') householdId: string,
    @Query('include') include?: string,
  ) {
    return this.goalsService.listFinancialGoals(householdId, include);
  }

  @Get(':goalId')
  getFinancialGoal(
    @Param('householdId') householdId: string,
    @Param('goalId') goalId: string,
  ) {
    return this.goalsService.getFinancialGoal(householdId, goalId);
  }

  @Post()
  createFinancialGoal(
    @Param('householdId') householdId: string,
    @Body() payload: CreateFinancialGoalDto,
  ) {
    return this.goalsService.createFinancialGoal(householdId, payload);
  }

  @Patch(':goalId')
  updateFinancialGoal(
    @Param('householdId') householdId: string,
    @Param('goalId') goalId: string,
    @Body() payload: UpdateFinancialGoalDto,
  ) {
    return this.goalsService.updateFinancialGoal(householdId, goalId, payload);
  }

  @Delete(':goalId')
  deleteFinancialGoal(
    @Param('householdId') householdId: string,
    @Param('goalId') goalId: string,
  ) {
    return this.goalsService.deleteFinancialGoal(householdId, goalId);
  }

  /**
   * Month by month: what actually went into this goal, against the declared
   * pace. Read from the progress frozen into each snapshot.
   */
  @Get(':goalId/monthly-progress')
  monthlyProgress(
    @Param('householdId') householdId: string,
    @Param('goalId') goalId: string,
  ) {
    return this.goalsService.monthlyProgress(householdId, goalId);
  }

  /**
   * Why the goal's figure moved since the last frozen point — the explanation
   * that makes a self-repricing number trustworthy instead of arbitrary.
   */
  @Get(':goalId/progress-change')
  progressChange(
    @Param('householdId') householdId: string,
    @Param('goalId') goalId: string,
  ) {
    return this.goalsService.progressChange(householdId, goalId);
  }

  /** Which assets count towards a goal, and by how much. */
  @Get(':goalId/allocations')
  listAllocations(
    @Param('householdId') householdId: string,
    @Param('goalId') goalId: string,
  ) {
    return this.goalsService.listAllocations(householdId, goalId);
  }

  @Post(':goalId/allocations')
  createAllocation(
    @Param('householdId') householdId: string,
    @Param('goalId') goalId: string,
    @Body() payload: CreateGoalAllocationDto,
  ) {
    return this.goalsService.createAllocation(householdId, goalId, payload);
  }

  @Patch(':goalId/allocations/:allocationId')
  updateAllocation(
    @Param('householdId') householdId: string,
    @Param('goalId') goalId: string,
    @Param('allocationId') allocationId: string,
    @Body() payload: UpdateGoalAllocationDto,
  ) {
    return this.goalsService.updateAllocation(
      householdId,
      goalId,
      allocationId,
      payload,
    );
  }

  @Delete(':goalId/allocations/:allocationId')
  deleteAllocation(
    @Param('householdId') householdId: string,
    @Param('goalId') goalId: string,
    @Param('allocationId') allocationId: string,
  ) {
    return this.goalsService.deleteAllocation(
      householdId,
      goalId,
      allocationId,
    );
  }
}
