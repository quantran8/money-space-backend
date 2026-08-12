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
import { RequireCapability } from '../auth/decorators/require-capability.decorator';

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

  @RequireCapability('edit')
  @Post()
  createFinancialGoal(
    @Param('householdId') householdId: string,
    @Body() payload: CreateFinancialGoalDto,
  ) {
    return this.goalsService.createFinancialGoal(householdId, payload);
  }

  @RequireCapability('edit')
  @Patch(':goalId')
  updateFinancialGoal(
    @Param('householdId') householdId: string,
    @Param('goalId') goalId: string,
    @Body() payload: UpdateFinancialGoalDto,
  ) {
    return this.goalsService.updateFinancialGoal(householdId, goalId, payload);
  }

  @RequireCapability('edit')
  @Delete(':goalId')
  deleteFinancialGoal(
    @Param('householdId') householdId: string,
    @Param('goalId') goalId: string,
  ) {
    return this.goalsService.deleteFinancialGoal(householdId, goalId);
  }
}
