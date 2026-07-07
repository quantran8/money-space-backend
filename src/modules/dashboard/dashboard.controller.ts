import { Controller, Get, Param } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller('api/households/:householdId')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('dashboard')
  getDashboard(@Param('householdId') householdId: string) {
    return this.dashboardService.getDashboard(householdId);
  }

  @Get('attention-items')
  listAttentionItems(@Param('householdId') householdId: string) {
    return this.dashboardService.listAttentionItems(householdId);
  }
}
