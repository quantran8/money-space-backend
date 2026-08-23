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
import type { CreateDebtDto } from './dto/create-debt.dto';
import type { ListDebtsQuery } from './dto/list-debts.query';
import type { UpdateDebtDto } from './dto/update-debt.dto';
import { DebtsService } from './debts.service';
import { CurrentMembership } from '../auth/decorators/current-membership.decorator';
import type { HouseholdMembership } from '../auth/guards/household-access.guard';

@Controller('households/:householdId/debts')
export class DebtsController {
  constructor(private readonly debtsService: DebtsService) {}

  @Get()
  listDebts(
    @Param('householdId') householdId: string,
    @Query() query: ListDebtsQuery,
  ) {
    return this.debtsService.listDebts(householdId, query);
  }

  @Get(':debtId')
  getDebt(
    @Param('householdId') householdId: string,
    @Param('debtId') debtId: string,
  ) {
    return this.debtsService.getDebt(householdId, debtId);
  }

  @Post()
  createDebt(
    @Param('householdId') householdId: string,
    @Body() payload: CreateDebtDto,
    @CurrentMembership() membership?: HouseholdMembership,
  ) {
    return this.debtsService.createDebt(
      householdId,
      payload,
      membership?.memberId,
    );
  }

  @Patch(':debtId')
  updateDebt(
    @Param('householdId') householdId: string,
    @Param('debtId') debtId: string,
    @Body() payload: UpdateDebtDto,
  ) {
    return this.debtsService.updateDebt(householdId, debtId, payload);
  }

  @Delete(':debtId')
  deleteDebt(
    @Param('householdId') householdId: string,
    @Param('debtId') debtId: string,
  ) {
    return this.debtsService.deleteDebt(householdId, debtId);
  }
}
