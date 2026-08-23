import { Controller, Get, Param } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller('households/:householdId')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('dashboard')
  getDashboard(@Param('householdId') householdId: string) {
    return this.dashboardService.getDashboard(householdId);
  }

  // `GET attention-items` moved to AttentionController. It lived here as a
  // dashboard sub-resource, but v3.1 attention is `stored ∪ derived` computed
  // off the forecast — a different dependency graph, and two handlers on the
  // same path would have resolved by registration order.
}
