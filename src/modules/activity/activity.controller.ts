import { Controller, Get, Param, Query } from '@nestjs/common';
import { ActivityService, type ActivityQuery } from './activity.service';

/**
 * Ungated beyond membership, on purpose: the journal is what both partners rely
 * on to see what the other did, so restricting it would remove the very thing
 * that replaced the permission system.
 */
@Controller('households/:householdId/activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  listActivity(
    @Param('householdId') householdId: string,
    @Query() query: ActivityQuery,
  ) {
    return this.activity.listActivity(householdId, query);
  }
}
