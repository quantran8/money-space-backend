import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import { GoalsService } from './goals.service';

/**
 * "Which goals is this asset backing, and how much of it is still free?"
 *
 * Lives in the goals module, under the ASSETS path, because that is where the
 * answer comes from: `AssetsService` cannot resolve it without importing
 * `GoalsService`, and `GoalsService` already imports `AssetsService` — the
 * reverse edge would be a cycle. Mounting the route here keeps the dependency
 * one-way while still giving the asset page the URL it expects.
 */
@Controller('api/households/:householdId/assets')
export class AssetGoalUsageController {
  constructor(private readonly goalsService: GoalsService) {}

  @Get(':assetId/goal-usage')
  assetGoalUsage(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
  ) {
    return this.goalsService.assetGoalUsage(householdId, assetId);
  }

  /**
   * "If I spend this much from this wallet, what does it cost my goals?"
   *
   * A READ, called while the household is still filling in the cashflow form.
   * Nothing is saved: the point is to show the cost BEFORE the outflow exists,
   * because an outflow outranks the goals sharing its wallet and would
   * otherwise shrink them silently.
   */
  @Get(':assetId/spend-impact')
  spendImpact(
    @Param('householdId') householdId: string,
    @Param('assetId') assetId: string,
    @Query('amount') amount?: string,
  ) {
    const parsed = Number(amount);
    if (!amount || !Number.isFinite(parsed) || parsed < 0) {
      throw new BadRequestException('amount must be a non-negative number');
    }
    return this.goalsService.spendImpact(householdId, assetId, parsed);
  }
}
