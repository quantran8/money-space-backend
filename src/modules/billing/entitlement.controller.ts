import { Controller, Get, Param } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';

@Controller('households/:householdId')
export class EntitlementController {
  constructor(private readonly entitlements: EntitlementService) {}

  /**
   * What this household's plan currently allows, including `limits` in full.
   *
   * The limits ship in the response on purpose: the clients render every
   * ceiling from this answer and hardcode no number, so changing what Free
   * includes is a backend edit and needs no app-store release.
   */
  @Get('entitlement')
  getEntitlement(@Param('householdId') householdId: string) {
    return this.entitlements.forHouseholdWithUsage(householdId);
  }
}
