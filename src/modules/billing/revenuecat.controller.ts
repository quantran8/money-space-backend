import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { CurrentMembership } from '../auth/decorators/current-membership.decorator';
import type { HouseholdMembership } from '../auth/guards/household-access.guard';
import { RevenuecatService } from './revenuecat.service';

/**
 * Registering a subscriber before they buy, so a renewal a year later can be
 * attributed. `householdId` comes from the authenticated membership, never the
 * body. See `memory/billing-and-entitlement.md`.
 */
@Controller('households/:householdId/revenuecat')
export class RevenuecatController {
  constructor(private readonly revenuecat: RevenuecatService) {}

  @Post('link')
  link(
    @Body() payload: { appUserId?: string },
    @CurrentMembership() membership?: HouseholdMembership,
  ) {
    if (!membership) {
      throw new BadRequestException('household membership is required');
    }
    const appUserId = payload?.appUserId?.trim();
    if (!appUserId) {
      throw new BadRequestException('appUserId is required');
    }

    return this.revenuecat.linkSubscriber(
      membership.householdId,
      membership.userId,
      appUserId,
    );
  }
}
