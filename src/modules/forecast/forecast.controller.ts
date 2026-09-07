import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ForecastService } from './forecast.service';
import { NoCacheInvalidation } from '../../common/cache/no-cache-invalidation.decorator';
import type { WhatIfRequestDto } from './dto/what-if.dto';

/**
 * The read-only calculation surface.
 *
 * Note what is NOT here: no `@RequireCapability('edit')` anywhere, including on
 * `POST /what-if`. Running a simulation is a READ — it writes nothing — so a
 * `view_summary` partner must be able to ask "what happens if we spend this?".
 * It is a POST only because it needs a request body.
 *
 * There is no `@RequirePremium()` here either, and `/forecast-bundle` in
 * particular must never carry one: it serves a Free household at horizon 30,
 * which is the view that drives adoption. What is gated is the horizon VALUE,
 * resolved in the service where `householdId` already is — one chokepoint
 * rather than four.
 */
@Controller('households/:householdId')
export class ForecastController {
  constructor(private readonly forecast: ForecastService) {}

  @Get('forecast')
  getForecast(
    @Param('householdId') householdId: string,
    @Query('horizon_days') horizonDays?: string,
  ) {
    return this.forecast.forecastForRequest(householdId, horizonDays);
  }

  @Get('flexible-money')
  getFlexibleMoney(
    @Param('householdId') householdId: string,
    @Query('horizon_days') horizonDays?: string,
  ) {
    return this.forecast.flexibleMoneyForRequest(householdId, horizonDays);
  }

  @Get('financial-state')
  getFinancialState(
    @Param('householdId') householdId: string,
    @Query('horizon_days') horizonDays?: string,
  ) {
    return this.forecast.financialStateForRequest(householdId, horizonDays);
  }

  /**
   * Forecast + flexible money + financial state in one response, from one load
   * of the bundle. Home needs all three; asking for them separately cost three
   * requests, three bundle loads and three engine runs for one answer.
   */
  @Get('forecast-bundle')
  getForecastBundle(
    @Param('householdId') householdId: string,
    @Query('horizon_days') horizonDays?: string,
  ) {
    return this.forecast.forecastBundleForRequest(householdId, horizonDays);
  }

  // Writes nothing (see the class doc), so it must not drop the household's
  // cache — what-if is run repeatedly in a row while tuning an amount.
  @NoCacheInvalidation()
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
