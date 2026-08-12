import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ForecastService } from './forecast.service';
import type { WhatIfRequestDto } from './dto/what-if.dto';

/**
 * The read-only calculation surface.
 *
 * Note what is NOT here: no `@RequireCapability('edit')` anywhere, including on
 * `POST /what-if`. Running a simulation is a READ — it writes nothing — so a
 * `view_summary` partner must be able to ask "what happens if we spend this?".
 * It is a POST only because it needs a request body.
 */
@Controller('api/households/:householdId')
export class ForecastController {
  constructor(private readonly forecast: ForecastService) {}

  @Get('forecast')
  getForecast(
    @Param('householdId') householdId: string,
    @Query('horizon_days') horizonDays?: string,
  ) {
    return this.forecast.forecast(
      householdId,
      this.forecast.parseHorizon(horizonDays),
    );
  }

  @Get('flexible-money')
  getFlexibleMoney(
    @Param('householdId') householdId: string,
    @Query('horizon_days') horizonDays?: string,
  ) {
    return this.forecast.flexibleMoney(
      householdId,
      this.forecast.parseHorizon(horizonDays),
    );
  }

  @Get('financial-state')
  getFinancialState(
    @Param('householdId') householdId: string,
    @Query('horizon_days') horizonDays?: string,
  ) {
    return this.forecast.financialState(
      householdId,
      this.forecast.parseHorizon(horizonDays),
    );
  }

  @Post('what-if')
  runWhatIf(
    @Param('householdId') householdId: string,
    @Body() payload: WhatIfRequestDto,
  ) {
    return this.forecast.whatIf(householdId, payload);
  }

  @Get('financial-goals/:goalId/projection')
  getGoalProjection(
    @Param('householdId') householdId: string,
    @Param('goalId') goalId: string,
  ) {
    return this.forecast.goalProjection(householdId, goalId);
  }
}
