import { Controller, Get, Param } from '@nestjs/common';
import { HouseholdsService } from './households.service';

@Controller('api/households')
export class HouseholdsController {
  constructor(private readonly householdsService: HouseholdsService) {}

  @Get()
  listHouseholds() {
    return this.householdsService.listHouseholds();
  }

  @Get(':householdId')
  getHousehold(@Param('householdId') householdId: string) {
    return this.householdsService.getHousehold(householdId);
  }
}
